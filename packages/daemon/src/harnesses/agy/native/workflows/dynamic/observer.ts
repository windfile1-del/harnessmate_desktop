import crypto from 'node:crypto';
import {
  NativeWorkSchema,
  NativeWorkflowResourceItemDtoSchema,
  NativeWorkflowSchema,
  asActivityId,
  asWorkId,
  asWorkflowId,
  sanitizeNativeWorkForPublic,
  sanitizeNativeWorkflowForPublic,
  sanitizeObservedForPublic,
  toPublicEvidenceDto,
  type ActivityId,
  type Evidence,
  type NativeAgentId,
  type NativeAlias,
  type NativeRequestReceiptState,
  type NativeWork,
  type NativeWorkflow,
  type NativeWorkflowResourceItemDto,
  type NativeWorkflowResourceKind,
  type Observed,
  type PublicEvidenceDto,
  type RpcId,
  type RuntimeBinding,
  type WorkId,
  type WorkOutcome,
  type WorkState,
  type WorkflowId,
} from '@harnessmate/protocol';
import type {
  NativeRequestTargetResolution,
  NativeRequestTargetResolverInput,
} from '../../requests/types.js';
import type { AgyNativeRuntimeRegistry } from '../../wiring/registry.js';
import type {
  NativeCommitMutation,
  NativeEventDraft,
  NativeIngress,
  NativeWorkflowResourceReaderPort,
} from '../../wiring/types.js';
import { decodeDynamicWorkflowIngress } from './codec.js';
import {
  FrozenDynamicWorkflowArtifactReaderStub,
  isValidOpaqueArtifactId,
  type DynamicWorkflowArtifactReaderPort,
} from './ports.js';
import {
  DYNAMIC_WORKFLOW_OBSERVER_CONTRACT_REVISION,
  type DecodedDynamicStepPatch,
  type DynamicScriptApprovalState,
  type DynamicStructuredOutputSummary,
  type DynamicWorkflowArtifactRecord,
  type DynamicWorkflowCommitBatch,
  type DynamicWorkflowIngestResult,
  type DynamicWorkflowLifecyclePhase,
  type DynamicWorkflowLogEntry,
  type DynamicWorkflowObservedSnapshot,
  type DynamicWorkflowScriptPreviewDto,
  type DynamicWorkflowStepRecord,
  type DynamicWorkflowStepViewDto,
  type DynamicWorkflowTimelineEntry,
} from './types.js';

const DEFAULT_MAX_LOGS_PER_WORKFLOW = 500;
const DEFAULT_MAX_TIMELINE_PER_WORKFLOW = 500;
const DEFAULT_MAX_PREVIEW_LINES = 80;
const DEFAULT_MAX_JSON_PREVIEW_CHARS = 2000;

interface InternalRequestTrack {
  readonly approvalId: string;
  readonly isScriptApproval: boolean;
  readonly isInteractionQuestion: boolean;
  readonly stepId?: string;
  receiptState: NativeRequestReceiptState;
  updatedAt: number;
}

interface InternalWorkflowState {
  readonly workflowId: WorkflowId;
  readonly workflowNativeId: string;
  readonly binding: RuntimeBinding;
  readonly originActivityId: ActivityId;
  readonly turnId: string | null;
  title: string;
  objective?: string;
  state: Observed<WorkState>;
  outcome?: Observed<WorkOutcome>;
  lifecyclePhase: DynamicWorkflowLifecyclePhase;
  scriptArtifactId?: string;
  scriptText?: string;
  scriptPathRedacted: boolean;
  scriptApprovalState: DynamicScriptApprovalState;
  scriptApprovalId?: string;
  scriptEvidence?: Evidence;
  readonly toolCallIds: Set<string>;
  readonly stepsById: Map<string, DynamicWorkflowStepRecord>;
  readonly stepOrder: string[];
  readonly workByStepId: Map<string, NativeWork>;
  readonly resultArtifactIds: string[];
  readonly resultSummariesById: Map<string, DynamicStructuredOutputSummary>;
  readonly artifactsById: Map<string, DynamicWorkflowArtifactRecord>;
  readonly logs: DynamicWorkflowLogEntry[];
  totalLogCount: number;
  droppedLogCount: number;
  readonly timeline: DynamicWorkflowTimelineEntry[];
  timelineSeq: number;
  readonly requestsByApprovalId: Map<string, InternalRequestTrack>;
  readonly confirmedChildAgentsByStep: Map<string, Set<NativeAgentId>>;
  revision: number;
  updatedAt: number;
  isHistoricalReplay: boolean;
}

interface BindingScopeState {
  readonly binding: RuntimeBinding;
  readonly seenIngressKeys: Set<string>;
  readonly workflowsById: Map<WorkflowId, InternalWorkflowState>;
  readonly workflowIdByNativeId: Map<string, WorkflowId>;
  readonly workflowIdByToolCallId: Map<string, WorkflowId>;
  rootNativeSessionId?: string;
  transportClosed: boolean;
}

export interface DynamicWorkflowObserverOptions {
  readonly enabled?: boolean;
  readonly strictMode?: boolean;
  readonly maxLogsPerWorkflow?: number;
  readonly maxTimelinePerWorkflow?: number;
  readonly artifactReader?: DynamicWorkflowArtifactReaderPort;
  readonly now?: () => number;
}

function stableShortHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

function makeEvidenceFromEnvelope(envelope: NativeIngress, nowMs: number): Evidence {
  if (envelope.channel === 'history_replay') {
    return {
      kind: 'replay',
      captureId: `replay_${envelope.connectionId}`,
      ordinal: Math.max(0, envelope.ingressOrdinal),
      observedAt: nowMs,
    };
  }
  return {
    kind: 'live_protocol',
    connectionId: envelope.connectionId,
    ingressOrdinal: Math.max(0, envelope.ingressOrdinal),
    wireVariant: 'acp_v1',
    observedAt: nowMs,
  };
}

function isTerminalWorkState(state: WorkState): boolean {
  return state === 'finished' || state === 'failed' || state === 'cancelled';
}

function analyzeStepDag(steps: readonly DynamicWorkflowStepRecord[]): {
  hasVerifiedDag: boolean;
  unavailableReason?: string;
} {
  if (steps.length === 0) {
    return { hasVerifiedDag: false, unavailableReason: 'no_steps_observed' };
  }
  const stepIds = new Set(steps.map((s) => s.id));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of stepIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  let validEdgeCount = 0;
  for (const step of steps) {
    for (const dep of step.after ?? []) {
      if (!stepIds.has(dep) || dep === step.id) continue;
      validEdgeCount += 1;
      adj.get(dep)!.push(step.id);
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
    }
  }

  if (validEdgeCount === 0) {
    return { hasVerifiedDag: false, unavailableReason: 'no_dependency_edges_observed' };
  }

  // Kahn's topological cycle check
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const curr = queue.shift()!;
    visited += 1;
    for (const next of adj.get(curr) ?? []) {
      const nextDeg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
    }
  }

  if (visited !== stepIds.size) {
    return { hasVerifiedDag: false, unavailableReason: 'cyclic_dependency_edges_detected' };
  }

  return { hasVerifiedDag: true };
}

function summarizeStructuredPayload(
  payload: unknown,
  provenance: PublicEvidenceDto,
  artifactId?: string,
): DynamicStructuredOutputSummary {
  if (Array.isArray(payload)) {
    let previewJson: string;
    try {
      previewJson = JSON.stringify(payload.slice(0, 20), null, 2);
    } catch {
      previewJson = '[unserializable_array]';
    }
    const truncated =
      payload.length > 20 || previewJson.length > DEFAULT_MAX_JSON_PREVIEW_CHARS;
    return {
      ...(artifactId ? { artifactId } : {}),
      format: 'json_array',
      totalItems: payload.length,
      previewJson: previewJson.slice(0, DEFAULT_MAX_JSON_PREVIEW_CHARS),
      truncated,
      provenance,
    };
  }

  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    const topLevelKeys = Object.keys(rec).slice(0, 32);
    let previewJson: string;
    try {
      previewJson = JSON.stringify(rec, null, 2);
    } catch {
      previewJson = '[unserializable_object]';
    }
    const truncated = previewJson.length > DEFAULT_MAX_JSON_PREVIEW_CHARS;
    return {
      ...(artifactId ? { artifactId } : {}),
      format: 'json_object',
      totalItems: Object.keys(rec).length,
      topLevelKeys,
      previewJson: previewJson.slice(0, DEFAULT_MAX_JSON_PREVIEW_CHARS),
      truncated,
      provenance,
    };
  }

  const rawText = typeof payload === 'string' ? payload : String(payload);
  const truncated = rawText.length > DEFAULT_MAX_JSON_PREVIEW_CHARS;
  return {
    ...(artifactId ? { artifactId } : {}),
    format: typeof payload === 'string' ? 'unparsed_text' : 'scalar',
    previewJson: rawText.slice(0, DEFAULT_MAX_JSON_PREVIEW_CHARS),
    truncated,
    provenance,
  };
}

function toSafeOpaqueId(prefix: string, raw: string): string {
  const sanitized = raw.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  if (isValidOpaqueArtifactId(`${prefix}_${sanitized}`) && `${prefix}_${sanitized}`.length <= 120) {
    return `${prefix}_${sanitized}`;
  }
  return `${prefix}_${stableShortHash(raw)}`;
}

/**
 * NP-11 Dynamic Workflow Observer & Resource Reader.
 *
 * Tracks AGY dynamic workflow triggers, read-only script review/denial, explicit
 * step/phase execution (serial & parallel), bounded log & structured result pagination,
 * AGY 1.5.16 forwarded questions, held-activity retention, and honest degradation when
 * dependency edges (`after`) or steps are absent.
 */
export class DynamicWorkflowObserver implements NativeWorkflowResourceReaderPort {
  readonly contractRevision = DYNAMIC_WORKFLOW_OBSERVER_CONTRACT_REVISION;
  private enabled: boolean;
  private readonly strictMode: boolean;
  private readonly maxLogsPerWorkflow: number;
  private readonly maxTimelinePerWorkflow: number;
  private readonly artifactReader: DynamicWorkflowArtifactReaderPort;
  private readonly internalArtifactStub: FrozenDynamicWorkflowArtifactReaderStub | null;
  private readonly now: () => number;
  private readonly scopesByKey = new Map<string, BindingScopeState>();

  constructor(options: DynamicWorkflowObserverOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.strictMode = options.strictMode ?? false;
    this.maxLogsPerWorkflow = options.maxLogsPerWorkflow ?? DEFAULT_MAX_LOGS_PER_WORKFLOW;
    this.maxTimelinePerWorkflow =
      options.maxTimelinePerWorkflow ?? DEFAULT_MAX_TIMELINE_PER_WORKFLOW;
    this.now = options.now ?? (() => Date.now());
    if (options.artifactReader) {
      this.artifactReader = options.artifactReader;
      this.internalArtifactStub =
        options.artifactReader instanceof FrozenDynamicWorkflowArtifactReaderStub
          ? options.artifactReader
          : null;
    } else {
      const stub = new FrozenDynamicWorkflowArtifactReaderStub();
      this.internalArtifactStub = stub;
      this.artifactReader = stub;
    }
  }

  setEnabled(next: boolean): void {
    this.enabled = next;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getArtifactReader(): DynamicWorkflowArtifactReaderPort {
    return this.artifactReader;
  }

  private scopeKey(binding: RuntimeBinding): string {
    return `${binding.runtimeId}::${binding.generation}`;
  }

  private getOrCreateScope(binding: RuntimeBinding): BindingScopeState {
    const key = this.scopeKey(binding);
    let scope = this.scopesByKey.get(key);
    if (!scope) {
      scope = {
        binding,
        seenIngressKeys: new Set<string>(),
        workflowsById: new Map<WorkflowId, InternalWorkflowState>(),
        workflowIdByNativeId: new Map<string, WorkflowId>(),
        workflowIdByToolCallId: new Map<string, WorkflowId>(),
        transportClosed: false,
      };
      this.scopesByKey.set(key, scope);
    }
    return scope;
  }

  registerRootSession(binding: RuntimeBinding, rootNativeSessionId: string): void {
    const scope = this.getOrCreateScope(binding);
    scope.rootNativeSessionId = rootNativeSessionId;
  }

  /**
   * Binds an already-confirmed NP-05 child agent to a specific dynamic workflow step.
   * Never creates confirmed child identity on its own.
   */
  linkConfirmedChildAgent(params: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly stepId: string;
    readonly agentId: NativeAgentId;
  }): void {
    const scope = this.scopesByKey.get(this.scopeKey(params.binding));
    const wf = scope?.workflowsById.get(params.workflowId);
    if (!wf) return;
    let set = wf.confirmedChildAgentsByStep.get(params.stepId);
    if (!set) {
      set = new Set<NativeAgentId>();
      wf.confirmedChildAgentsByStep.set(params.stepId, set);
    }
    set.add(params.agentId);
    const step = wf.stepsById.get(params.stepId);
    if (step && !step.agentIds.includes(params.agentId)) {
      wf.stepsById.set(params.stepId, {
        ...step,
        agentIds: [...step.agentIds, params.agentId],
      });
      wf.revision += 1;
    }
  }

  acceptFrame(
    envelope: NativeIngress,
    context?: {
      readonly originActivityId?: ActivityId;
      readonly turnId?: string | null;
      readonly rootNativeSessionId?: string;
      readonly nowMs?: number;
    },
  ): DynamicWorkflowIngestResult {
    if (!this.enabled) {
      return {
        accepted: false,
        deduplicated: false,
        ignoredDisabled: true,
        workflowIds: [],
        workIds: [],
        commits: {
          workflows: [],
          work: [],
          aliases: [],
          eventDrafts: [],
          mutationKeyBase: `dynwf_disabled_${envelope.ingressOrdinal}`,
        },
      };
    }

    const scope = this.getOrCreateScope(envelope.binding);
    if (context?.rootNativeSessionId) {
      scope.rootNativeSessionId = context.rootNativeSessionId;
    }

    const dedupKey = `${envelope.connectionId}::${envelope.ingressOrdinal}`;
    if (scope.seenIngressKeys.has(dedupKey)) {
      return {
        accepted: false,
        deduplicated: true,
        ignoredDisabled: false,
        workflowIds: [],
        workIds: [],
        commits: {
          workflows: [],
          work: [],
          aliases: [],
          eventDrafts: [],
          mutationKeyBase: `dynwf_dedup_${envelope.ingressOrdinal}`,
        },
      };
    }

    const decoded = decodeDynamicWorkflowIngress(envelope, { strictMode: this.strictMode });
    if (decoded.kind === 'not_dynamic_workflow') {
      return {
        accepted: false,
        deduplicated: false,
        ignoredDisabled: false,
        workflowIds: [],
        workIds: [],
        commits: {
          workflows: [],
          work: [],
          aliases: [],
          eventDrafts: [],
          mutationKeyBase: `dynwf_skip_${envelope.ingressOrdinal}`,
        },
      };
    }

    scope.seenIngressKeys.add(dedupKey);
    const nowMs = context?.nowMs ?? this.now();
    const evidence = makeEvidenceFromEnvelope(envelope, nowMs);
    const pubEvidence = toPublicEvidenceDto(evidence, nowMs);
    const isHistoryReplay = envelope.channel === 'history_replay';

    if (decoded.kind === 'dynamic_workflow_request') {
      const wfNativeId =
        decoded.workflowNativeId ??
        decoded.toolCallId ??
        `req_${String(decoded.wireRequestId)}`;
      const wf = this.ensureWorkflowRecord({
        scope,
        workflowNativeId: wfNativeId,
        toolCallId: decoded.toolCallId,
        title: decoded.summary,
        originActivityId: context?.originActivityId,
        turnId: context?.turnId ?? null,
        nowMs,
        evidence,
        isHistoryReplay,
      });

      if (decoded.scriptText) {
        this.attachApprovedScript(wf, decoded.scriptText, evidence, nowMs);
      }
      if (decoded.scriptPathRedacted) {
        wf.scriptPathRedacted = true;
      }
      if (decoded.isScriptApproval && wf.scriptApprovalState === 'unknown') {
        wf.scriptApprovalState = 'pending';
      }
      if (!isHistoryReplay) {
        wf.lifecyclePhase = decoded.isScriptApproval
          ? 'awaiting_script_approval'
          : 'awaiting_step_action';
        wf.state = {
          kind: 'known',
          value: 'requires_action',
          evidence,
        };
      }
      wf.revision += 1;
      wf.updatedAt = nowMs;
      this.appendTimelineEntry(wf, {
        timestamp: nowMs,
        kind: 'approval',
        stepId: decoded.stepId,
        title: decoded.isInteractionQuestion
          ? '收到工作流结构化问题'
          : decoded.isScriptApproval
            ? '等待用户批准动态工作流脚本'
            : '等待工作流节点权限确认',
        detail: decoded.summary,
        status: 'requires_action',
        provenance: pubEvidence,
      });

      const commits = this.buildCommitBatch(wf, [], [], `dynwf_req_${envelope.connectionId}_${envelope.ingressOrdinal}`);
      return {
        accepted: true,
        deduplicated: false,
        ignoredDisabled: false,
        workflowIds: [wf.workflowId],
        workIds: [],
        pendingRequestHint: {
          wireRequestId: decoded.wireRequestId,
          method: decoded.method,
          actualNativeSessionId: decoded.actualNativeSessionId,
          workflowId: wf.workflowId,
          ...(decoded.stepId ? { stepId: decoded.stepId } : {}),
          ...(decoded.toolCallId ? { toolCallId: decoded.toolCallId } : {}),
          isInteractionQuestion: decoded.isInteractionQuestion,
        },
        commits,
      };
    }

    // `dynamic_tool_patch`
    const wf = this.ensureWorkflowRecord({
      scope,
      workflowNativeId: decoded.workflowNativeId,
      toolCallId: decoded.toolCallId,
      title: decoded.title,
      objective: decoded.objective,
      originActivityId: context?.originActivityId,
      turnId: context?.turnId ?? null,
      nowMs,
      evidence,
      isHistoryReplay,
    });

    const isNewWorkflow = wf.revision === 0;
    if (decoded.title && !wf.title) {
      wf.title = decoded.title;
    }
    if (decoded.objective && !wf.objective) {
      wf.objective = decoded.objective;
    }
    if (decoded.scriptText) {
      this.attachApprovedScript(wf, decoded.scriptText, evidence, nowMs);
    }
    if (decoded.scriptPathRedacted) {
      wf.scriptPathRedacted = true;
    }
    if (isNewWorkflow) {
      this.appendTimelineEntry(wf, {
        timestamp: nowMs,
        kind: 'trigger',
        title: `观察到动态工作流触发：${wf.title}`,
        detail: wf.objective,
        provenance: pubEvidence,
      });
    }

    const updatedWorks: NativeWork[] = [];
    const newAliases: {
      targetEntityKind: 'activity' | 'work' | 'agent' | 'workflow' | 'runtime';
      targetEntityId: string;
      alias: NativeAlias;
    }[] = [
      {
        targetEntityKind: 'workflow',
        targetEntityId: wf.workflowId,
        alias: {
          namespace: 'workflow',
          nativeValue: decoded.workflowNativeId,
          evidence,
        },
      },
    ];

    if (decoded.logText) {
      this.appendLogEntry(wf, {
        stepId: decoded.stepId,
        level: decoded.logLevel,
        summary: decoded.logText,
        truncated: decoded.logTruncated,
        createdAt: nowMs,
        provenance: pubEvidence,
        scopeLabel: decoded.stepId ? `step:${decoded.stepId}` : 'workflow',
      });
    }

    if (decoded.structuredOutputPayload !== undefined || decoded.resultArtifactId) {
      const artId = this.registerWorkflowResultArtifact(
        wf,
        decoded.resultArtifactId,
        decoded.structuredOutputPayload,
        undefined,
        evidence,
        nowMs,
      );
      this.appendTimelineEntry(wf, {
        timestamp: nowMs,
        kind: 'artifact',
        title: `收到工作流结果产物 ${artId}`,
        provenance: pubEvidence,
      });
    }

    for (const stepPatch of decoded.steps) {
      const { step, work } = this.applyStepPatch(
        wf,
        stepPatch,
        decoded.blocking,
        evidence,
        pubEvidence,
        nowMs,
      );
      if (work) {
        updatedWorks.push(work);
        newAliases.push({
          targetEntityKind: 'work',
          targetEntityId: work.id,
          alias: {
            namespace: 'task',
            nativeValue: `${wf.workflowNativeId}:${step.id}`,
            evidence,
          },
        });
      }
    }

    if (decoded.workflowState) {
      wf.state = {
        kind: 'known',
        value: decoded.workflowState,
        evidence,
      };
      if (decoded.workflowOutcome) {
        wf.outcome = {
          kind: 'known',
          value: decoded.workflowOutcome,
          evidence,
        };
      } else if (decoded.workflowOutcomeReasonCode) {
        wf.outcome = {
          kind: 'unknown',
          reasonCode: decoded.workflowOutcomeReasonCode,
        };
      }
    } else if (wf.state.kind === 'unknown' && wf.stepsById.size > 0) {
      wf.state = { kind: 'known', value: 'running', evidence };
    }

    wf.lifecyclePhase = this.computeLifecyclePhase(wf);
    wf.revision += 1;
    wf.updatedAt = nowMs;

    const commits = this.buildCommitBatch(
      wf,
      updatedWorks,
      newAliases,
      `dynwf_${envelope.connectionId}_${envelope.ingressOrdinal}`,
    );

    return {
      accepted: true,
      deduplicated: false,
      ignoredDisabled: false,
      workflowIds: [wf.workflowId],
      workIds: updatedWorks.map((w) => w.id),
      commits,
    };
  }

  /**
   * Records a workflow-associated permission or 1.5.16 question receipt tracked by NP-07.
   */
  onWorkflowRequestObserved(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly approvalId: string;
    readonly isScriptApproval: boolean;
    readonly isInteractionQuestion: boolean;
    readonly stepId?: string;
    readonly nowMs?: number;
  }): void {
    if (!this.enabled) return;
    const scope = this.scopesByKey.get(this.scopeKey(input.binding));
    const wf = scope?.workflowsById.get(input.workflowId);
    if (!wf) return;

    const nowMs = input.nowMs ?? this.now();
    wf.requestsByApprovalId.set(input.approvalId, {
      approvalId: input.approvalId,
      isScriptApproval: input.isScriptApproval,
      isInteractionQuestion: input.isInteractionQuestion,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      receiptState: 'pending',
      updatedAt: nowMs,
    });

    if (input.isScriptApproval) {
      wf.scriptApprovalId = input.approvalId;
      wf.scriptApprovalState = 'pending';
    }
    wf.lifecyclePhase = this.computeLifecyclePhase(wf);
    wf.revision += 1;
    wf.updatedAt = nowMs;
  }

  /**
   * Synchronizes NP-07 receipt resolution (approve, reject/deny, cancel, expiry, connection_lost).
   * Rejecting/cancelling a script approval transitions the workflow cleanly to cancelled/denied
   * and releases held activity retention.
   */
  onWorkflowRequestResolved(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly approvalId: string;
    readonly receiptState: NativeRequestReceiptState;
    readonly selectedOptionId?: string;
    readonly isRejectedDecision?: boolean;
    readonly nowMs?: number;
  }): NativeWorkflow | null {
    if (!this.enabled) return null;
    const scope = this.scopesByKey.get(this.scopeKey(input.binding));
    const wf = scope?.workflowsById.get(input.workflowId);
    if (!wf) return null;

    const nowMs = input.nowMs ?? this.now();
    const existing = wf.requestsByApprovalId.get(input.approvalId);
    const isScriptApproval = existing?.isScriptApproval || wf.scriptApprovalId === input.approvalId;
    const isRejected =
      input.isRejectedDecision === true ||
      input.receiptState === 'cancelled' ||
      input.receiptState === 'expired' ||
      (input.selectedOptionId !== undefined &&
        /^(reject|deny|decline)/i.test(input.selectedOptionId));

    if (existing) {
      existing.receiptState = input.receiptState;
      existing.updatedAt = nowMs;
    } else {
      wf.requestsByApprovalId.set(input.approvalId, {
        approvalId: input.approvalId,
        isScriptApproval,
        isInteractionQuestion: false,
        receiptState: input.receiptState,
        updatedAt: nowMs,
      });
    }

    const hostEvidence: Evidence = {
      kind: 'host_observation',
      observedAt: nowMs,
      reasonCode: isRejected ? 'workflow_approval_denied' : `request_${input.receiptState}`,
    };
    const pubEvidence = toPublicEvidenceDto(hostEvidence, nowMs);

    if (isScriptApproval) {
      if (input.receiptState === 'expired') {
        wf.scriptApprovalState = 'expired';
      } else if (isRejected) {
        wf.scriptApprovalState = input.receiptState === 'cancelled' ? 'cancelled' : 'denied';
      } else if (input.receiptState === 'response_written') {
        wf.scriptApprovalState = 'approved';
      }

      if (isRejected) {
        wf.state = {
          kind: 'known',
          value: 'cancelled',
          evidence: hostEvidence,
        };
        wf.outcome = {
          kind: 'known',
          value: 'cancelled',
          evidence: hostEvidence,
        };
        // Any still-active step cannot claim to run after script denial
        for (const [stepId, step] of wf.stepsById.entries()) {
          const cur = step.state.kind === 'known' ? step.state.value : 'unknown';
          if (!isTerminalWorkState(cur)) {
            wf.stepsById.set(stepId, {
              ...step,
              state: { kind: 'known', value: 'cancelled', evidence: hostEvidence },
              outcome: { kind: 'known', value: 'cancelled', evidence: hostEvidence },
            });
          }
        }
        for (const [stepId, work] of wf.workByStepId.entries()) {
          const cur = work.state.kind === 'known' ? work.state.value : 'unknown';
          if (!isTerminalWorkState(cur)) {
            wf.workByStepId.set(stepId, {
              ...work,
              blocking: 'detached',
              state: { kind: 'known', value: 'cancelled', evidence: hostEvidence },
              outcome: { kind: 'known', value: 'cancelled', evidence: hostEvidence },
              revision: work.revision + 1,
            });
          }
        }
      }
    }

    this.appendTimelineEntry(wf, {
      timestamp: nowMs,
      kind: 'approval',
      stepId: existing?.stepId,
      title: isScriptApproval
        ? isRejected
          ? '脚本执行请求被拒绝或取消'
          : '已提交脚本批准响应'
        : isRejected
          ? '工作流交互请求已取消/拒绝'
          : '已提交工作流交互响应',
      detail: `approvalId=${input.approvalId} state=${input.receiptState}`,
      status: isRejected ? 'cancelled' : 'running',
      provenance: pubEvidence,
    });

    wf.lifecyclePhase = this.computeLifecyclePhase(wf);
    wf.revision += 1;
    wf.updatedAt = nowMs;

    return this.buildNativeWorkflowEntity(wf);
  }

  /**
   * NP-07 target attribution seam for Dynamic Workflow permissions & AGY 1.5.16 forwarded questions.
   */
  resolveRequestTarget(
    input: NativeRequestTargetResolverInput,
  ): NativeRequestTargetResolution | null {
    const scope = this.scopesByKey.get(this.scopeKey(input.binding));
    if (!scope) return null;

    let wf: InternalWorkflowState | undefined;
    if (input.workflowIdHint) {
      const mappedId = scope.workflowIdByNativeId.get(input.workflowIdHint);
      if (mappedId) {
        wf = scope.workflowsById.get(mappedId);
      } else {
        wf = scope.workflowsById.get(input.workflowIdHint as WorkflowId);
      }
    }
    if (!wf && input.toolCallId) {
      const mappedId = scope.workflowIdByToolCallId.get(input.toolCallId);
      if (mappedId) wf = scope.workflowsById.get(mappedId);
    }
    if (!wf) return null;

    const rootSession = input.rootNativeSessionId ?? scope.rootNativeSessionId ?? null;
    const forwardedToParentSession =
      Boolean(rootSession && input.actualNativeSessionId === rootSession) &&
      (Boolean(input.childSessionHint) ||
        Boolean(input.toolCallId?.startsWith('interaction_')) ||
        Boolean(input.workflowIdHint));

    return {
      scope: 'confirmed_workflow',
      targetLineage: 'confirmed',
      activityId: wf.originActivityId,
      workflowId: wf.workflowId,
      workflowKind: 'dynamic',
      workflowLabel: wf.title,
      turnId: wf.turnId,
      isDetached: wf.turnId === null,
      forwardedToParentSession,
      provenanceReason: forwardedToParentSession
        ? 'dynamic_workflow_forwarded_via_parent_session'
        : 'dynamic_workflow_confirmed_scope',
    };
  }

  /**
   * Reports active retention reasons holding the workflow activity (blocking steps or pending requests).
   */
  listRetentionReasons(binding: RuntimeBinding): string[] {
    if (!this.enabled) return [];
    const scope = this.scopesByKey.get(this.scopeKey(binding));
    if (!scope || scope.transportClosed) return [];

    const reasons: string[] = [];
    for (const wf of scope.workflowsById.values()) {
      if (wf.isHistoricalReplay) continue;
      for (const req of wf.requestsByApprovalId.values()) {
        if (req.receiptState === 'pending') {
          reasons.push(`dynamic_workflow_request:${req.approvalId}`);
        }
      }
      for (const work of wf.workByStepId.values()) {
        if (work.blocking !== 'confirmed_blocking') continue;
        if (
          work.state.kind === 'known' &&
          !isTerminalWorkState(work.state.value)
        ) {
          reasons.push(`dynamic_workflow_step:${work.id}`);
        }
      }
      if (
        wf.state.kind === 'known' &&
        !isTerminalWorkState(wf.state.value) &&
        wf.workByStepId.size === 0
      ) {
        reasons.push(`dynamic_workflow_active:${wf.workflowId}`);
      }
    }
    return reasons;
  }

  handleTransportClosed(
    binding: RuntimeBinding,
    _connectionId: string,
    reason = 'transport_closed',
  ): NativeWorkflow[] {
    const scope = this.scopesByKey.get(this.scopeKey(binding));
    if (!scope) return [];
    scope.transportClosed = true;

    const nowMs = this.now();
    const hostEvidence: Evidence = {
      kind: 'host_observation',
      observedAt: nowMs,
      reasonCode: reason,
    };
    const updated: NativeWorkflow[] = [];

    for (const wf of scope.workflowsById.values()) {
      const currentState = wf.state.kind === 'known' ? wf.state.value : undefined;
      if (currentState && isTerminalWorkState(currentState)) continue;

      wf.state = {
        kind: 'stale',
        ...(currentState ? { last: currentState } : {}),
        evidence: hostEvidence,
        reasonCode: reason,
      };
      for (const [stepId, step] of wf.stepsById.entries()) {
        const sVal = step.state.kind === 'known' ? step.state.value : undefined;
        if (sVal && isTerminalWorkState(sVal)) continue;
        wf.stepsById.set(stepId, {
          ...step,
          state: {
            kind: 'stale',
            ...(sVal ? { last: sVal } : {}),
            evidence: hostEvidence,
            reasonCode: reason,
          },
        });
      }
      for (const [stepId, work] of wf.workByStepId.entries()) {
        const wVal = work.state.kind === 'known' ? work.state.value : undefined;
        if (wVal && isTerminalWorkState(wVal)) continue;
        wf.workByStepId.set(stepId, {
          ...work,
          state: {
            kind: 'stale',
            ...(wVal ? { last: wVal } : {}),
            evidence: hostEvidence,
            reasonCode: reason,
          },
          revision: work.revision + 1,
        });
      }
      for (const req of wf.requestsByApprovalId.values()) {
        if (req.receiptState === 'pending') {
          req.receiptState = 'connection_lost';
          req.updatedAt = nowMs;
        }
      }
      wf.lifecyclePhase = 'stale';
      wf.revision += 1;
      wf.updatedAt = nowMs;
      updated.push(this.buildNativeWorkflowEntity(wf));
    }

    return updated;
  }

  handleGenerationChanged(prevBinding: RuntimeBinding, _nextBinding: RuntimeBinding): void {
    const scope = this.scopesByKey.get(this.scopeKey(prevBinding));
    if (!scope) return;
    scope.transportClosed = true;
    const nowMs = this.now();
    for (const wf of scope.workflowsById.values()) {
      for (const req of wf.requestsByApprovalId.values()) {
        if (req.receiptState === 'pending') {
          req.receiptState = 'connection_lost';
          req.updatedAt = nowMs;
        }
      }
    }
  }

  /**
   * `NativeWorkflowResourceReaderPort` implementation for `/native/workflows/:workflowId/:resource`.
   * Remains readable for already-observed entities even when live ingestion is disabled.
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
    if (input.resource === 'board') {
      return {
        revision: 0,
        available: false,
        sourceUnavailableReason: 'dynamic_workflow_board_not_applicable',
        items: [],
        nextPageToken: null,
        hasMore: false,
      };
    }

    const scope = this.scopesByKey.get(this.scopeKey(input.binding));
    const wf = scope?.workflowsById.get(input.workflowId);
    if (!wf) {
      return {
        revision: 0,
        available: false,
        sourceUnavailableReason: 'dynamic_workflow_not_found_in_binding',
        items: [],
        nextPageToken: null,
        hasMore: false,
      };
    }

    const offset = parseOffset(input.pageToken);
    const limit = Math.max(1, Math.min(input.limit, 200));
    const nowMs = this.now();

    if (input.resource === 'phases') {
      if (wf.stepOrder.length === 0) {
        return {
          revision: wf.revision,
          available: false,
          sourceUnavailableReason: 'dynamic_workflow_phases_not_observed',
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }
      const sliceIds = wf.stepOrder.slice(offset, offset + limit);
      const items: NativeWorkflowResourceItemDto[] = sliceIds.map((id) => {
        const step = wf.stepsById.get(id)!;
        const summaryParts: string[] = [];
        if (step.executionMode !== 'unknown') summaryParts.push(`mode:${step.executionMode}`);
        if (step.errorSummary) summaryParts.push(`error:${step.errorSummary}`);
        if (step.resultArtifactIds.length > 0) {
          summaryParts.push(`results:${step.resultArtifactIds.length}`);
        }
        return NativeWorkflowResourceItemDtoSchema.parse({
          kind: 'phase',
          stage: {
            id: step.id,
            label: step.label,
            state: sanitizeObservedForPublic(step.state, nowMs),
            ...(step.after !== undefined ? { after: [...step.after] } : {}),
            ...(step.agentIds.length > 0 ? { agentIds: [...step.agentIds] } : {}),
          },
          ...(summaryParts.length > 0 ? { summary: summaryParts.join(' · ').slice(0, 1000) } : {}),
        });
      });
      const nextOffset = offset + items.length;
      const hasMore = nextOffset < wf.stepOrder.length;
      return {
        revision: wf.revision,
        available: true,
        items,
        nextPageToken: hasMore ? String(nextOffset) : null,
        hasMore,
      };
    }

    if (input.resource === 'logs') {
      if (wf.logs.length === 0) {
        return {
          revision: wf.revision,
          available: false,
          sourceUnavailableReason: 'dynamic_workflow_logs_not_observed',
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }
      const sliced = wf.logs.slice(offset, offset + limit);
      const items: NativeWorkflowResourceItemDto[] = sliced.map((entry) =>
        NativeWorkflowResourceItemDtoSchema.parse({
          kind: 'log_entry',
          entryId: entry.entryId,
          seq: entry.seq,
          level: entry.level,
          summary: entry.summary,
          truncated: entry.truncated,
          createdAt: entry.createdAt,
          evidence: entry.provenance,
        }),
      );
      const nextOffset = offset + items.length;
      const hasMore = nextOffset < wf.logs.length;
      return {
        revision: wf.revision,
        available: true,
        items,
        nextPageToken: hasMore ? String(nextOffset) : null,
        hasMore,
      };
    }

    // `artifacts`
    const allArtifacts = [...wf.artifactsById.values()];
    if (allArtifacts.length === 0) {
      return {
        revision: wf.revision,
        available: false,
        sourceUnavailableReason: 'dynamic_workflow_artifacts_not_observed',
        items: [],
        nextPageToken: null,
        hasMore: false,
      };
    }
    const sliced = allArtifacts.slice(offset, offset + limit);
    const items: NativeWorkflowResourceItemDto[] = sliced.map((art) =>
      NativeWorkflowResourceItemDtoSchema.parse({
        kind: 'artifact_ref',
        artifactId: art.artifactId,
        title: art.title,
        artifactKind: art.artifactKind,
        ...(art.ownerAgentId ? { ownerAgentId: art.ownerAgentId } : {}),
        ...(art.activityId ? { activityId: art.activityId } : {}),
        revision: art.revision,
        updatedAt: art.updatedAt,
        evidence: art.provenance,
      }),
    );
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < allArtifacts.length;
    return {
      revision: wf.revision,
      available: true,
      items,
      nextPageToken: hasMore ? String(nextOffset) : null,
      hasMore,
    };
  }

  getObservedWorkflowSnapshot(
    binding: RuntimeBinding,
    workflowId: WorkflowId,
  ): DynamicWorkflowObservedSnapshot | null {
    const scope = this.scopesByKey.get(this.scopeKey(binding));
    const wf = scope?.workflowsById.get(workflowId);
    if (!wf) return null;
    return this.buildObservedSnapshot(wf);
  }

  listObservedWorkflowSnapshots(binding: RuntimeBinding): DynamicWorkflowObservedSnapshot[] {
    const scope = this.scopesByKey.get(this.scopeKey(binding));
    if (!scope) return [];
    return [...scope.workflowsById.values()].map((wf) => this.buildObservedSnapshot(wf));
  }

  commitToRegistry(
    registry: AgyNativeRuntimeRegistry,
    binding: RuntimeBinding,
    commits: DynamicWorkflowCommitBatch,
  ): void {
    const nowMs = this.now();
    if (
      commits.workflows.length === 0 &&
      commits.work.length === 0 &&
      commits.aliases.length === 0
    ) {
      return;
    }

    if (commits.workflows.length > 0) {
      const primary = commits.workflows[0]!;
      const resourceIds = [
        ...(primary.detail.kind === 'dynamic' && primary.detail.scriptArtifactId
          ? [primary.detail.scriptArtifactId]
          : []),
        ...(primary.detail.kind === 'dynamic' ? (primary.detail.resultArtifactIds ?? []) : []),
      ];
      registry.commitAndPublish(
        binding,
        {
          workflows: commits.workflows,
          ...(commits.work.length > 0 ? { work: commits.work } : {}),
          ...(commits.aliases.length > 0 ? { aliases: commits.aliases } : {}),
        },
        {
          type: 'native.workflow.changed',
          turnId: null,
          payload: {
            workflow: sanitizeNativeWorkflowForPublic(primary, nowMs),
            ...(resourceIds.length > 0 ? { resourceIds } : {}),
          },
          mutationKey: `${commits.mutationKeyBase}:wf:${primary.id}:${primary.revision}`,
        },
      );
    }

    for (const workItem of commits.work) {
      registry.commitAndPublish(
        binding,
        { work: [workItem] },
        {
          type: 'native.work.changed',
          turnId: null,
          payload: {
            work: sanitizeNativeWorkForPublic(workItem, nowMs),
          },
          mutationKey: `${commits.mutationKeyBase}:wk:${workItem.id}:${workItem.revision}`,
        },
      );
    }
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  private ensureWorkflowRecord(params: {
    readonly scope: BindingScopeState;
    readonly workflowNativeId: string;
    readonly toolCallId?: string;
    readonly title?: string;
    readonly objective?: string;
    readonly originActivityId?: ActivityId;
    readonly turnId: string | null;
    readonly nowMs: number;
    readonly evidence: Evidence;
    readonly isHistoryReplay: boolean;
  }): InternalWorkflowState {
    const { scope } = params;
    let workflowId =
      scope.workflowIdByNativeId.get(params.workflowNativeId) ??
      (params.toolCallId ? scope.workflowIdByToolCallId.get(params.toolCallId) : undefined);

    if (!workflowId) {
      workflowId = asWorkflowId(toSafeOpaqueId('wf_dyn', params.workflowNativeId));
      scope.workflowIdByNativeId.set(params.workflowNativeId, workflowId);
    }
    if (params.toolCallId) {
      scope.workflowIdByToolCallId.set(params.toolCallId, workflowId);
    }

    let wf = scope.workflowsById.get(workflowId);
    if (!wf) {
      const originActivityId =
        params.originActivityId ??
        asActivityId(toSafeOpaqueId('act_dyn', `${scope.binding.generation}_${params.workflowNativeId}`));
      wf = {
        workflowId,
        workflowNativeId: params.workflowNativeId,
        binding: scope.binding,
        originActivityId,
        turnId: params.turnId,
        title: params.title ?? `Dynamic Workflow (${params.workflowNativeId})`,
        ...(params.objective ? { objective: params.objective } : {}),
        state: {
          kind: 'unknown',
          reasonCode: 'workflow_awaiting_execution_evidence',
        },
        lifecyclePhase: 'triggered',
        scriptPathRedacted: false,
        scriptApprovalState: 'unknown',
        toolCallIds: new Set<string>(params.toolCallId ? [params.toolCallId] : []),
        stepsById: new Map(),
        stepOrder: [],
        workByStepId: new Map(),
        resultArtifactIds: [],
        resultSummariesById: new Map(),
        artifactsById: new Map(),
        logs: [],
        totalLogCount: 0,
        droppedLogCount: 0,
        timeline: [],
        timelineSeq: 0,
        requestsByApprovalId: new Map(),
        confirmedChildAgentsByStep: new Map(),
        revision: 0,
        updatedAt: params.nowMs,
        isHistoricalReplay: params.isHistoryReplay,
      };
      scope.workflowsById.set(workflowId, wf);
    } else if (params.toolCallId) {
      wf.toolCallIds.add(params.toolCallId);
    }

    return wf;
  }

  private attachApprovedScript(
    wf: InternalWorkflowState,
    scriptText: string,
    evidence: Evidence,
    nowMs: number,
  ): void {
    const artId = wf.scriptArtifactId ?? toSafeOpaqueId('art_script', wf.workflowId);
    wf.scriptArtifactId = artId;
    wf.scriptText = scriptText;
    wf.scriptEvidence = evidence;
    if (wf.scriptApprovalState === 'unknown') {
      wf.scriptApprovalState = 'pending';
    }

    this.internalArtifactStub?.registerApprovedScript({
      binding: wf.binding,
      workflowId: wf.workflowId,
      artifactId: artId,
      text: scriptText,
      evidence,
    });

    const prevArt = wf.artifactsById.get(artId);
    wf.artifactsById.set(artId, {
      artifactId: artId,
      title: '生成的工作流脚本 (Python 只读审阅)',
      artifactKind: 'script',
      activityId: wf.originActivityId,
      revision: (prevArt?.revision ?? 0) + 1,
      updatedAt: nowMs,
      approvedScope: true,
      provenance: toPublicEvidenceDto(evidence, nowMs),
    });
  }

  private registerWorkflowResultArtifact(
    wf: InternalWorkflowState,
    explicitArtifactId: string | undefined,
    payload: unknown,
    stepId: string | undefined,
    evidence: Evidence,
    nowMs: number,
  ): string {
    const rawId =
      explicitArtifactId && isValidOpaqueArtifactId(explicitArtifactId)
        ? explicitArtifactId
        : toSafeOpaqueId('art_res', `${wf.workflowId}_${stepId ?? 'root'}_${wf.resultArtifactIds.length + 1}`);
    if (!wf.resultArtifactIds.includes(rawId)) {
      wf.resultArtifactIds.push(rawId);
    }

    const pubEv = toPublicEvidenceDto(evidence, nowMs);
    let summary: DynamicStructuredOutputSummary | undefined;
    if (payload !== undefined) {
      summary = summarizeStructuredPayload(payload, pubEv, rawId);
      wf.resultSummariesById.set(rawId, summary);
      this.internalArtifactStub?.registerApprovedStructuredResult({
        binding: wf.binding,
        workflowId: wf.workflowId,
        artifactId: rawId,
        payload,
        evidence,
      });
    }

    const prev = wf.artifactsById.get(rawId);
    wf.artifactsById.set(rawId, {
      artifactId: rawId,
      title: stepId ? `节点 ${stepId} 结构化结果` : `工作流输出产物 ${rawId}`,
      artifactKind:
        summary && (summary.format === 'json_array' || summary.format === 'json_object')
          ? 'json'
          : 'text',
      ...(stepId ? { stepId } : {}),
      activityId: wf.originActivityId,
      revision: (prev?.revision ?? 0) + 1,
      updatedAt: nowMs,
      approvedScope: Boolean(payload !== undefined || explicitArtifactId),
      ...(summary ? { structuredSummary: summary } : {}),
      provenance: pubEv,
    });
    return rawId;
  }

  private applyStepPatch(
    wf: InternalWorkflowState,
    patch: DecodedDynamicStepPatch,
    blocking: 'confirmed_blocking' | 'detached' | 'unknown',
    evidence: Evidence,
    pubEvidence: PublicEvidenceDto,
    nowMs: number,
  ): { readonly step: DynamicWorkflowStepRecord; readonly work?: NativeWork } {
    const existing = wf.stepsById.get(patch.id);
    if (!existing && !wf.stepOrder.includes(patch.id)) {
      wf.stepOrder.push(patch.id);
    }

    const linkedAgents = [...(wf.confirmedChildAgentsByStep.get(patch.id) ?? [])];
    const nextState: Observed<WorkState> = patch.state
      ? { kind: 'known', value: patch.state, evidence }
      : existing?.state ?? {
          kind: 'unknown',
          reasonCode: patch.stateReasonCode ?? 'step_status_not_reported',
        };

    const nextOutcome: Observed<WorkOutcome> | undefined = patch.outcome
      ? { kind: 'known', value: patch.outcome, evidence }
      : patch.outcomeReasonCode
        ? { kind: 'unknown', reasonCode: patch.outcomeReasonCode }
        : existing?.outcome;

    let resultArtifactIds = existing ? [...existing.resultArtifactIds] : [];
    let structuredOutput = existing?.structuredOutput;
    if (patch.structuredPayload !== undefined || patch.resultArtifactId) {
      const artId = this.registerWorkflowResultArtifact(
        wf,
        patch.resultArtifactId,
        patch.structuredPayload,
        patch.id,
        evidence,
        nowMs,
      );
      if (!resultArtifactIds.includes(artId)) {
        resultArtifactIds.push(artId);
      }
      structuredOutput = wf.resultSummariesById.get(artId) ?? structuredOutput;
    }

    let logCount = existing?.logCount ?? 0;
    if (patch.logText) {
      this.appendLogEntry(wf, {
        stepId: patch.id,
        level: patch.logLevel ?? 'info',
        summary: patch.logText,
        truncated: Boolean(patch.logTruncated),
        createdAt: nowMs,
        provenance: pubEvidence,
        scopeLabel: `step:${patch.id}`,
      });
      logCount += 1;
    }

    const startedAt =
      existing?.startedAt ??
      (patch.state === 'running' || patch.state === 'finished' || patch.state === 'failed'
        ? nowMs
        : undefined);
    const finishedAt =
      patch.state && isTerminalWorkState(patch.state) ? nowMs : existing?.finishedAt;

    const workId =
      existing?.workIds[0] ??
      asWorkId(toSafeOpaqueId('wk_dyn', `${wf.workflowId}_${patch.id}`));

    const stepRecord: DynamicWorkflowStepRecord = {
      id: patch.id,
      label: patch.label ?? existing?.label ?? patch.id,
      state: nextState,
      ...(nextOutcome ? { outcome: nextOutcome } : {}),
      ...(patch.after !== undefined
        ? { after: patch.after }
        : existing?.after !== undefined
          ? { after: existing.after }
          : {}),
      executionMode:
        patch.executionMode && patch.executionMode !== 'unknown'
          ? patch.executionMode
          : existing?.executionMode ?? 'unknown',
      agentIds: linkedAgents,
      workIds: [workId],
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(finishedAt !== undefined ? { finishedAt } : {}),
      ...(patch.errorSummary
        ? { errorSummary: patch.errorSummary }
        : existing?.errorSummary
          ? { errorSummary: existing.errorSummary }
          : {}),
      resultArtifactIds,
      ...(structuredOutput ? { structuredOutput } : {}),
      logCount,
    };

    wf.stepsById.set(patch.id, stepRecord);

    const prevWork = wf.workByStepId.get(patch.id);
    const workRecord = NativeWorkSchema.parse({
      id: workId,
      kind: 'workflow_step',
      originActivityId: wf.originActivityId,
      ...(linkedAgents[0] ? { ownerAgentId: linkedAgents[0] } : {}),
      workflowId: wf.workflowId,
      blocking:
        nextState.kind === 'known' && isTerminalWorkState(nextState.value)
          ? 'detached'
          : blocking,
      state: nextState,
      ...(nextOutcome ? { outcome: nextOutcome } : {}),
      observedLabel: stepRecord.label.slice(0, 240),
      revision: (prevWork?.revision ?? 0) + 1,
    });
    wf.workByStepId.set(patch.id, workRecord);

    if (!existing || existing.state !== nextState || patch.errorSummary) {
      this.appendTimelineEntry(wf, {
        timestamp: nowMs,
        kind: patch.state === 'failed' ? 'error' : 'step',
        stepId: patch.id,
        workId,
        ...(linkedAgents[0] ? { agentId: linkedAgents[0] } : {}),
        title: `节点 ${stepRecord.label}`,
        detail: patch.errorSummary ?? (patch.state ? `状态更新为 ${patch.state}` : undefined),
        ...(nextState.kind === 'known' ? { status: nextState.value } : {}),
        provenance: pubEvidence,
      });
    }

    return { step: stepRecord, work: workRecord };
  }

  private appendLogEntry(
    wf: InternalWorkflowState,
    entry: Omit<DynamicWorkflowLogEntry, 'entryId' | 'seq'>,
  ): void {
    wf.totalLogCount += 1;
    const seq = wf.totalLogCount;
    const item: DynamicWorkflowLogEntry = {
      ...entry,
      entryId: `log_${wf.workflowId}_${seq}`,
      seq,
    };
    wf.logs.push(item);
    if (wf.logs.length > this.maxLogsPerWorkflow) {
      wf.logs.shift();
      wf.droppedLogCount += 1;
    }
  }

  private appendTimelineEntry(
    wf: InternalWorkflowState,
    entry: Omit<DynamicWorkflowTimelineEntry, 'entryId' | 'seq'>,
  ): void {
    wf.timelineSeq += 1;
    wf.timeline.push({
      ...entry,
      entryId: `tl_${wf.workflowId}_${wf.timelineSeq}`,
      seq: wf.timelineSeq,
    });
    if (wf.timeline.length > this.maxTimelinePerWorkflow) {
      wf.timeline.shift();
    }
  }

  private computeLifecyclePhase(wf: InternalWorkflowState): DynamicWorkflowLifecyclePhase {
    if (wf.state.kind === 'stale') return 'stale';
    if (
      wf.scriptApprovalState === 'denied' ||
      wf.scriptApprovalState === 'cancelled' ||
      wf.scriptApprovalState === 'expired'
    ) {
      return 'script_denied';
    }
    const hasPendingReq = [...wf.requestsByApprovalId.values()].some(
      (r) => r.receiptState === 'pending',
    );
    if (wf.scriptApprovalState === 'pending' && hasPendingReq) {
      return 'awaiting_script_approval';
    }
    if (hasPendingReq) {
      return 'awaiting_step_action';
    }

    const steps = [...wf.stepsById.values()];
    const hasFailedStep = steps.some((s) => s.state.kind === 'known' && s.state.value === 'failed');
    const hasSucceededStep = steps.some(
      (s) =>
        (s.outcome?.kind === 'known' && s.outcome.value === 'succeeded') ||
        (s.state.kind === 'known' && s.state.value === 'finished'),
    );
    const hasRunningStep = steps.some(
      (s) =>
        s.state.kind === 'known' &&
        (s.state.value === 'running' || s.state.value === 'queued' || s.state.value === 'waiting'),
    );

    if (wf.state.kind === 'known') {
      if (wf.state.value === 'cancelled') return 'cancelled';
      if (wf.state.value === 'failed') {
        return hasSucceededStep || wf.resultArtifactIds.length > 0
          ? 'partial_results'
          : 'failed';
      }
      if (wf.state.value === 'finished') {
        return hasFailedStep ? 'partial_results' : 'finished';
      }
      if (wf.state.value === 'requires_action') {
        return 'awaiting_step_action';
      }
      if (wf.state.value === 'running' || wf.state.value === 'queued' || wf.state.value === 'waiting') {
        return hasFailedStep && (hasSucceededStep || wf.resultArtifactIds.length > 0)
          ? 'partial_results'
          : 'running';
      }
    }

    if (hasRunningStep) return 'running';
    if (hasFailedStep && (hasSucceededStep || wf.resultArtifactIds.length > 0)) {
      return 'partial_results';
    }
    if (hasFailedStep) return 'failed';
    return wf.stepsById.size > 0 || wf.scriptArtifactId ? 'triggered' : 'unknown';
  }

  private buildNativeWorkflowEntity(wf: InternalWorkflowState): NativeWorkflow {
    const steps = wf.stepOrder
      .map((id) => wf.stepsById.get(id))
      .filter((s): s is DynamicWorkflowStepRecord => Boolean(s))
      .map((s) => ({
        id: s.id,
        label: s.label,
        state: s.state,
        ...(s.after !== undefined ? { after: [...s.after] } : {}),
        ...(s.agentIds.length > 0 ? { agentIds: [...s.agentIds] } : {}),
      }));

    return NativeWorkflowSchema.parse({
      id: wf.workflowId,
      originActivityId: wf.originActivityId,
      state: wf.state,
      detail: {
        kind: 'dynamic',
        ...(wf.scriptArtifactId ? { scriptArtifactId: wf.scriptArtifactId } : {}),
        ...(steps.length > 0 ? { steps } : {}),
        ...(wf.resultArtifactIds.length > 0
          ? { resultArtifactIds: [...wf.resultArtifactIds] }
          : {}),
      },
      revision: wf.revision,
    });
  }

  private buildCommitBatch(
    wf: InternalWorkflowState,
    works: readonly NativeWork[],
    aliases: readonly {
      readonly targetEntityKind: 'activity' | 'work' | 'agent' | 'workflow' | 'runtime';
      readonly targetEntityId: string;
      readonly alias: NativeAlias;
    }[],
    mutationKeyBase: string,
  ): DynamicWorkflowCommitBatch {
    const nowMs = this.now();
    const workflow = this.buildNativeWorkflowEntity(wf);
    const workflowDto = sanitizeNativeWorkflowForPublic(workflow, nowMs);
    const resourceIds = [
      ...(wf.scriptArtifactId ? [wf.scriptArtifactId] : []),
      ...wf.resultArtifactIds,
    ];

    const eventDrafts: NativeEventDraft[] = [
      {
        type: 'native.workflow.changed',
        turnId: wf.turnId,
        payload: {
          workflow: workflowDto,
          ...(resourceIds.length > 0 ? { resourceIds } : {}),
        },
        mutationKey: `${mutationKeyBase}:wf:${workflow.id}:${workflow.revision}`,
      },
    ];

    for (const work of works) {
      eventDrafts.push({
        type: 'native.work.changed',
        turnId: wf.turnId,
        payload: {
          work: sanitizeNativeWorkForPublic(work, nowMs),
        },
        mutationKey: `${mutationKeyBase}:wk:${work.id}:${work.revision}`,
      });
    }

    return {
      workflows: [workflow],
      work: works,
      aliases,
      eventDrafts,
      mutationKeyBase,
    };
  }

  private buildObservedSnapshot(wf: InternalWorkflowState): DynamicWorkflowObservedSnapshot {
    const nowMs = this.now();
    const stepRecords = wf.stepOrder
      .map((id) => wf.stepsById.get(id))
      .filter((s): s is DynamicWorkflowStepRecord => Boolean(s));
    const dag = analyzeStepDag(stepRecords);

    const steps: DynamicWorkflowStepViewDto[] = stepRecords.map((s) => ({
      id: s.id,
      label: s.label,
      state: sanitizeObservedForPublic(s.state, nowMs),
      ...(s.outcome ? { outcome: sanitizeObservedForPublic(s.outcome, nowMs) } : {}),
      ...(s.after !== undefined ? { after: [...s.after] } : {}),
      executionMode: s.executionMode,
      agentIds: [...s.agentIds],
      workIds: [...s.workIds],
      ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
      ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
      ...(s.errorSummary ? { errorSummary: s.errorSummary } : {}),
      resultArtifactIds: [...s.resultArtifactIds],
      ...(s.structuredOutput ? { structuredOutput: s.structuredOutput } : {}),
      logCount: s.logCount,
    }));

    let scriptPreview: DynamicWorkflowScriptPreviewDto | undefined;
    if (wf.scriptArtifactId) {
      const page = this.artifactReader.readScriptPreview({
        binding: wf.binding,
        workflowId: wf.workflowId,
        artifactId: wf.scriptArtifactId,
        maxChars: 4000,
      });
      const rawLines = page.ok ? page.content.split(/\r?\n/) : [];
      const previewLines = rawLines.slice(0, DEFAULT_MAX_PREVIEW_LINES);
      const truncated =
        (page.ok && (page.hasMore || rawLines.length > DEFAULT_MAX_PREVIEW_LINES)) || false;
      const provenance: PublicEvidenceDto = wf.scriptEvidence
        ? toPublicEvidenceDto(wf.scriptEvidence, nowMs)
        : page.ok
          ? page.provenance
          : { sourceKind: 'host_observation', freshness: 'host', observedAt: wf.updatedAt };

      scriptPreview = {
        artifactId: wf.scriptArtifactId,
        approvalState: wf.scriptApprovalState,
        ...(wf.scriptApprovalId ? { approvalId: wf.scriptApprovalId } : {}),
        language: 'python',
        previewLines,
        ...(wf.scriptText ? { totalLines: wf.scriptText.split(/\r?\n/).length } : {}),
        truncated,
        nextPageToken: page.ok ? page.nextPageToken : null,
        provenance,
        sourceScopeNote: wf.scriptPathRedacted
          ? '已屏蔽未授权脚本路径，仅展示协议核准范围内的只读文本预览（不执行 Python）'
          : '只读文本预览（不执行 Python，批准经原生 Approval Router）',
        rawPathRedacted: wf.scriptPathRedacted,
      };
    }

    return {
      contractRevision: DYNAMIC_WORKFLOW_OBSERVER_CONTRACT_REVISION,
      workflowId: wf.workflowId,
      binding: wf.binding,
      originActivityId: wf.originActivityId,
      turnId: wf.turnId,
      title: wf.title,
      ...(wf.objective ? { objective: wf.objective } : {}),
      lifecyclePhase: wf.lifecyclePhase,
      workflow: this.buildNativeWorkflowEntity(wf),
      hasVerifiedDag: dag.hasVerifiedDag,
      ...(dag.unavailableReason ? { dagUnavailableReason: dag.unavailableReason } : {}),
      ...(scriptPreview ? { scriptPreview } : {}),
      steps,
      resultSummaries: [...wf.resultSummariesById.values()],
      artifacts: [...wf.artifactsById.values()],
      timeline: [...wf.timeline],
      totalLogCount: wf.totalLogCount,
      droppedLogCount: wf.droppedLogCount,
      activeRequestIds: [...wf.requestsByApprovalId.values()]
        .filter((r) => r.receiptState === 'pending')
        .map((r) => r.approvalId),
      revision: wf.revision,
      updatedAt: wf.updatedAt,
    };
  }
}

function parseOffset(token: string | undefined): number {
  if (!token) return 0;
  const n = Number.parseInt(token, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
