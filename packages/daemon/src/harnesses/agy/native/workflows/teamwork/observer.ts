import {
  NativeWorkflowSchema,
  asActivityId,
  asNativeAgentId,
  asWorkflowId,
  sanitizeNativeWorkflowForPublic,
  sanitizeObservedForPublic,
  toPublicEvidenceDto,
  type ActivityId,
  type AgentForeground,
  type AgentIdentity,
  type AgentLineage,
  type Evidence,
  type NativeAgentId,
  type NativeAlias,
  type NativeRequestReceiptState,
  type NativeRequestSummaryDto,
  type NativeStage,
  type NativeWorkflow,
  type NativeWorkflowResourceItemDto,
  type NativeWorkflowResourceKind,
  type Observed,
  type RuntimeBinding,
  type WorkOutcome,
  type WorkState,
  type WorkflowId,
} from '@harnessmate/protocol';
import type { AgyNativeRuntimeRegistry } from '../../wiring/registry.js';
import type { NativeIngress, NativeWorkflowResourceReaderPort } from '../../wiring/types.js';
import {
  DEFAULT_TEAMWORK_FEATURE_GATES,
  createDegradedTeamworkArtifactReviewStub,
  createStrictTeamworkPathAuthorizer,
  type TeamworkArtifactApprovalSubmissionResult,
  type TeamworkArtifactReviewPort,
  type TeamworkChildLineagePort,
  type TeamworkFeatureGateConfig,
  type TeamworkPathAuthorizationPort,
} from './ports.js';
import {
  TEAMWORK_CAPABILITY_ID,
  TEAMWORK_OBSERVER_CONTRACT_REVISION,
  TeamworkWorkbenchProjectionDtoSchema,
  containsRawHostPath,
  type TeamworkApprovalGateState,
  type TeamworkArtifactCategory,
  type TeamworkArtifactRefDto,
  type TeamworkAuditGateDto,
  type TeamworkCommandDiscoveryState,
  type TeamworkEventTraceEntryDto,
  type TeamworkLifecyclePhase,
  type TeamworkMilestoneDetailDto,
  type TeamworkProjectScopeDto,
  type TeamworkPromptArtifactDto,
  type TeamworkRoleAttributionDto,
  type TeamworkRoleKind,
  type TeamworkScopingQuestionDto,
  type TeamworkWorkbenchProjectionDto,
} from './schemas.js';
import {
  buildTeamworkEvidence,
  classifyTeamworkRoleKind,
  decodeTeamworkIngressSignals,
  isCanonicalTeamworkCommand,
  isLegacyTeamworkPreviewCommand,
} from './wire-codec.js';

const OFFICIAL_TEAMWORK_APP_GUIDE =
  '如需原生 Prompt Artifact 审阅批准或查看未授权的项目目录，请在官方 Antigravity App 或 CLI (/teamwork) 中继续操作。';

export interface TeamworkObserverOptions {
  readonly featureGates?: Partial<TeamworkFeatureGateConfig>;
  readonly artifactReviewPort?: TeamworkArtifactReviewPort;
  readonly pathAuthorizer?: TeamworkPathAuthorizationPort;
  readonly childLineagePort?: TeamworkChildLineagePort;
  readonly now?: () => number;
  readonly maxEventTraceEntries?: number;
}

export interface TeamworkWorkspaceContext {
  readonly hmWorkspaceId?: string;
  readonly hmWorkspaceLabel: string;
  readonly hmWorkspaceRoot?: string | null;
  readonly authorizedRoots?: readonly string[];
}

export interface TeamworkLaunchAttemptInput {
  readonly binding: RuntimeBinding;
  readonly rawCommand: string;
  readonly goalText: string;
  readonly originActivityId?: ActivityId;
  readonly scopingActivityId?: ActivityId;
  readonly connectionId?: string;
  readonly workspaceContext?: TeamworkWorkspaceContext;
}

export interface TeamworkLaunchAttemptResult {
  readonly accepted: boolean;
  readonly workflowId?: WorkflowId;
  readonly code?:
    | 'TEAMWORK_DISABLED'
    | 'LEGACY_PREVIEW_COMMAND_REJECTED'
    | 'INVALID_COMMAND'
    | 'COMMAND_NOT_ADVERTISED';
  readonly message: string;
}

export interface TeamworkRequestReceiptInput {
  readonly binding: RuntimeBinding;
  readonly request: NativeRequestSummaryDto;
  readonly stage: 'scoping' | 'prompt_artifact_approval';
  readonly promptSummary?: string;
  readonly dedupKey?: string;
  readonly selectedOptionId?: string;
  readonly selectedOptionLabel?: string;
  readonly decisionHint?: 'approve' | 'reject';
  readonly artifactId?: string;
  readonly evidence?: Evidence;
}

export interface TeamworkNaturalLanguageApprovalResult {
  readonly accepted: false;
  readonly code: 'NATURAL_LANGUAGE_APPROVAL_FORBIDDEN';
  readonly message: string;
  readonly officialFallbackHint: string;
}

export interface TeamworkPathOpenDecision {
  readonly allowed: boolean;
  readonly reasonCode: string;
  readonly projectLabel?: string;
  readonly officialFallbackHint?: string;
}

interface InternalScopingQuestion {
  readonly questionId: string;
  approvalId?: string;
  readonly dedupKey: string;
  readonly toolCallId?: string;
  promptSummary: string;
  requestKind: 'question' | 'elicitation' | 'permission';
  receiptState: NativeRequestReceiptState;
  receiptId?: string;
  selectedOptionLabel?: string;
  occurrence: number;
  duplicateDeliveriesIgnored: number;
  evidence: Evidence;
  updatedAt: number;
}

interface InternalPromptArtifact {
  readonly artifactId: string;
  title: string;
  revision: number;
  reviewGate: TeamworkApprovalGateState;
  approvalRequestId?: string;
  approvalReceiptId?: string;
  approvalReceiptState?: NativeRequestReceiptState;
  reasonCode?: string;
  previewExcerpt?: string;
  evidence: Evidence;
  updatedAt: number;
}

interface InternalProjectScope {
  hmWorkspaceId?: string;
  hmWorkspaceLabel: string;
  hmWorkspaceRoot?: string | null;
  authorizedRoots: string[];
  created: boolean;
  projectScopeId?: string;
  projectLabel?: string;
  /** Strictly server-side only; never serialized into public DTOs. */
  nativeProjectPath?: string;
  pathSource: 'native_event' | 'authorized_user_selection' | 'unknown';
  reparseCheckPassed: boolean;
  evidence?: Evidence;
}

interface InternalRoleEntry {
  readonly agentId: NativeAgentId;
  roleKind: TeamworkRoleKind;
  displayLabel: string;
  lineage: AgentLineage;
  foreground: Observed<AgentForeground>;
  milestoneIds: Set<string>;
  evidence: Evidence;
}

interface InternalMilestoneEntry {
  readonly id: string;
  label: string;
  state: Observed<WorkState>;
  outcome?: Observed<WorkOutcome>;
  after?: string[];
  agentIds: Set<NativeAgentId>;
  summary?: string;
  auditIds: Set<string>;
  artifactIds: Set<string>;
}

interface InternalAuditEntry {
  readonly auditId: string;
  milestoneId?: string;
  label: string;
  verdict: 'pending' | 'passed' | 'changes_requested' | 'failed' | 'cancelled' | 'unknown';
  auditorAgentId?: NativeAgentId;
  artifactId?: string;
  summary?: string;
  evidence: Evidence;
  updatedAt: number;
}

interface InternalArtifactEntry {
  readonly artifactId: string;
  title: string;
  category: TeamworkArtifactCategory;
  artifactKind: 'markdown' | 'text' | 'diff' | 'script' | 'json' | 'media' | 'unknown';
  milestoneId?: string;
  ownerAgentId?: NativeAgentId;
  activityId?: ActivityId;
  revision: number;
  updatedAt: number;
  evidence: Evidence;
}

interface InternalEventTrace {
  readonly seq: number;
  readonly eventKind: TeamworkEventTraceEntryDto['eventKind'];
  readonly summary: string;
  readonly entityId?: string;
  readonly reasonCode?: string;
  readonly evidence: Evidence;
}

interface InternalTeamworkBindingState {
  binding: RuntimeBinding;
  activeConnectionId: string | null;
  workflowId: WorkflowId;
  originActivityId: ActivityId;
  scopingActivityId?: ActivityId;
  revision: number;
  commandDiscovery: TeamworkCommandDiscoveryState;
  phase: TeamworkLifecyclePhase;
  workflowState: Observed<WorkState>;
  approvalGate: TeamworkApprovalGateState;
  scopingQuestions: Map<string, InternalScopingQuestion>;
  scopingKeyByApprovalId: Map<string, string>;
  scopingKeyByToolCallId: Map<string, string>;
  promptArtifact: InternalPromptArtifact | null;
  projectScope: InternalProjectScope;
  confirmedRoles: Map<NativeAgentId, InternalRoleEntry>;
  unconfirmedRoles: Map<NativeAgentId, InternalRoleEntry>;
  milestones: Map<string, InternalMilestoneEntry>;
  auditGates: Map<string, InternalAuditEntry>;
  artifacts: Map<string, InternalArtifactEntry>;
  eventTrace: InternalEventTrace[];
  nextTraceSeq: number;
  nextQuestionSeq: number;
  nextCandidateAgentSeq: number;
}

function bindingSlotKey(binding: Pick<RuntimeBinding, 'runtimeId' | 'sessionId' | 'instanceId'>): string {
  return `${binding.runtimeId}::${binding.sessionId}::${binding.instanceId}`;
}

function isTerminalReceipt(state: NativeRequestReceiptState): boolean {
  return (
    state === 'response_written' ||
    state === 'cancelled' ||
    state === 'expired' ||
    state === 'connection_lost' ||
    state === 'delivery_unknown'
  );
}

function isGateRejectedOrClosed(gate: TeamworkApprovalGateState): boolean {
  return gate === 'rejected' || gate === 'cancelled' || gate === 'expired';
}

function sanitizeLabel(raw: string, fallback: string, maxLen = 160): string {
  const trimmed = raw.trim();
  if (!trimmed || containsRawHostPath(trimmed)) return fallback;
  return trimmed.slice(0, maxLen);
}

function parsePageToken(token: string | undefined): number {
  if (!token) return 0;
  const parsed = Number.parseInt(token, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export class AgyTeamworkWorkflowObserver {
  private gates: TeamworkFeatureGateConfig;
  private readonly artifactReviewPort: TeamworkArtifactReviewPort;
  private readonly pathAuthorizer: TeamworkPathAuthorizationPort;
  private readonly childLineagePort?: TeamworkChildLineagePort;
  private readonly now: () => number;
  private readonly maxEventTraceEntries: number;
  private readonly statesBySlot = new Map<string, InternalTeamworkBindingState>();
  private readonly slotByWorkflowId = new Map<WorkflowId, string>();

  constructor(options?: TeamworkObserverOptions) {
    this.gates = Object.freeze({
      ...DEFAULT_TEAMWORK_FEATURE_GATES,
      ...options?.featureGates,
    });
    this.artifactReviewPort =
      options?.artifactReviewPort ?? createDegradedTeamworkArtifactReviewStub();
    this.pathAuthorizer = options?.pathAuthorizer ?? createStrictTeamworkPathAuthorizer();
    this.childLineagePort = options?.childLineagePort;
    this.now = options?.now ?? (() => Date.now());
    this.maxEventTraceEntries = options?.maxEventTraceEntries ?? 500;
  }

  getFeatureGates(): TeamworkFeatureGateConfig {
    return this.gates;
  }

  /**
   * Updates Teamwork feature gates at runtime.
   * Disabling Teamwork or disabling review controls preserves all already-observed history as strictly read-only.
   */
  configureGates(patch: Partial<TeamworkFeatureGateConfig>): TeamworkFeatureGateConfig {
    this.gates = Object.freeze({
      ...this.gates,
      ...patch,
    });
    const ts = this.now();
    for (const state of this.statesBySlot.values()) {
      this.appendTrace(state, {
        eventKind: 'feature_gate_changed',
        summary: `Teamwork feature gates updated (teamwork=${this.gates.teamworkEnabled}, reviewControl=${this.gates.reviewControlEnabled})`,
        reasonCode: !this.gates.teamworkEnabled
          ? 'teamwork_feature_disabled_readonly'
          : !this.gates.reviewControlEnabled
            ? 'teamwork_review_control_disabled_readonly'
            : 'teamwork_gates_enabled',
        evidence: {
          kind: 'host_observation',
          observedAt: ts,
          reasonCode: 'feature_gate_update',
        },
      });
    }
    return this.gates;
  }

  private ensureState(
    binding: RuntimeBinding,
    opts?: {
      readonly originActivityId?: ActivityId;
      readonly scopingActivityId?: ActivityId;
      readonly connectionId?: string;
      readonly workspaceContext?: TeamworkWorkspaceContext;
    },
  ): InternalTeamworkBindingState {
    const slotKey = bindingSlotKey(binding);
    const existing = this.statesBySlot.get(slotKey);
    if (existing) {
      if (opts?.workspaceContext) {
        existing.projectScope.hmWorkspaceId = opts.workspaceContext.hmWorkspaceId;
        existing.projectScope.hmWorkspaceLabel = sanitizeLabel(
          opts.workspaceContext.hmWorkspaceLabel,
          'HM Session Workspace',
        );
        existing.projectScope.hmWorkspaceRoot = opts.workspaceContext.hmWorkspaceRoot ?? null;
        existing.projectScope.authorizedRoots = [...(opts.workspaceContext.authorizedRoots ?? [])];
      }
      if (opts?.scopingActivityId && !existing.scopingActivityId) {
        existing.scopingActivityId = opts.scopingActivityId;
      }
      if (opts?.connectionId && !existing.activeConnectionId) {
        existing.activeConnectionId = opts.connectionId;
      }
      return existing;
    }

    const workflowId = asWorkflowId(`wf_teamwork_${binding.runtimeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    const originActivityId =
      opts?.originActivityId ?? asActivityId(`act_tw_origin_${binding.runtimeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);

    const created: InternalTeamworkBindingState = {
      binding,
      activeConnectionId: opts?.connectionId ?? null,
      workflowId,
      originActivityId,
      ...(opts?.scopingActivityId ? { scopingActivityId: opts.scopingActivityId } : {}),
      revision: 0,
      commandDiscovery: 'not_observed',
      phase: 'idle',
      workflowState: { kind: 'unknown', reasonCode: 'teamwork_not_started' },
      approvalGate: 'not_reached',
      scopingQuestions: new Map(),
      scopingKeyByApprovalId: new Map(),
      scopingKeyByToolCallId: new Map(),
      promptArtifact: null,
      projectScope: {
        hmWorkspaceId: opts?.workspaceContext?.hmWorkspaceId,
        hmWorkspaceLabel: sanitizeLabel(
          opts?.workspaceContext?.hmWorkspaceLabel ?? 'HM Session Workspace',
          'HM Session Workspace',
        ),
        hmWorkspaceRoot: opts?.workspaceContext?.hmWorkspaceRoot ?? null,
        authorizedRoots: [...(opts?.workspaceContext?.authorizedRoots ?? [])],
        created: false,
        pathSource: 'unknown',
        reparseCheckPassed: false,
      },
      confirmedRoles: new Map(),
      unconfirmedRoles: new Map(),
      milestones: new Map(),
      auditGates: new Map(),
      artifacts: new Map(),
      eventTrace: [],
      nextTraceSeq: 1,
      nextQuestionSeq: 1,
      nextCandidateAgentSeq: 1,
    };

    this.statesBySlot.set(slotKey, created);
    this.slotByWorkflowId.set(workflowId, slotKey);
    return created;
  }

  private getStateForBinding(binding: RuntimeBinding): InternalTeamworkBindingState | null {
    return this.statesBySlot.get(bindingSlotKey(binding)) ?? null;
  }

  private isGenerationCurrent(
    state: InternalTeamworkBindingState,
    binding: RuntimeBinding,
    connectionId?: string,
  ): boolean {
    if (state.binding.generation !== binding.generation) return false;
    if (connectionId && state.activeConnectionId && state.activeConnectionId !== connectionId) {
      return false;
    }
    return true;
  }

  private appendTrace(
    state: InternalTeamworkBindingState,
    entry: Omit<InternalEventTrace, 'seq'>,
  ): void {
    state.eventTrace.push({
      seq: state.nextTraceSeq++,
      ...entry,
    });
    if (state.eventTrace.length > this.maxEventTraceEntries) {
      state.eventTrace.splice(0, state.eventTrace.length - this.maxEventTraceEntries);
    }
  }

  private bumpRevision(state: InternalTeamworkBindingState): void {
    state.revision += 1;
  }

  /**
   * Registers/updates the HM workspace context so Teamwork project scope is cleanly distinguished
   * from HarnessMate's session workspace.
   */
  setWorkspaceContext(binding: RuntimeBinding, workspaceContext: TeamworkWorkspaceContext): void {
    this.ensureState(binding, { workspaceContext });
  }

  /**
   * Records explicit command advertisement from `available_commands_update`.
   * Explicitly separates `/teamwork` from legacy `/teamwork-preview`.
   */
  recordCommandCatalogObservation(
    binding: RuntimeBinding,
    advertisedCommands: readonly string[],
    evidence: Evidence,
  ): TeamworkCommandDiscoveryState {
    const state = this.ensureState(binding);
    if (!this.isGenerationCurrent(state, binding)) return state.commandDiscovery;
    if (!this.gates.teamworkEnabled) return state.commandDiscovery;

    const normalized = advertisedCommands.map((c) => c.trim().replace(/^\/+/, '').toLowerCase());
    const hasCanonical = normalized.includes('teamwork');
    const hasLegacyPreview = normalized.includes('teamwork-preview');

    if (hasCanonical) {
      state.commandDiscovery = 'advertised';
    } else if (hasLegacyPreview) {
      state.commandDiscovery = 'legacy_preview_unverified';
    } else {
      state.commandDiscovery = 'not_advertised';
    }

    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'command_discovery',
      summary: hasCanonical
        ? '已观察到原生 /teamwork 命令广告'
        : hasLegacyPreview
          ? '仅观察到旧 /teamwork-preview 名称，未假定其等价于当前 /teamwork'
          : '当前 available_commands_update 未广告 /teamwork',
      reasonCode: state.commandDiscovery,
      evidence,
    });

    return state.commandDiscovery;
  }

  /**
   * Validates and records a user-initiated `/teamwork` launch attempt.
   * Rejects legacy `/teamwork-preview` rather than assuming it works.
   */
  recordLaunchAttempt(input: TeamworkLaunchAttemptInput): TeamworkLaunchAttemptResult {
    const state = this.ensureState(input.binding, {
      originActivityId: input.originActivityId,
      scopingActivityId: input.scopingActivityId,
      connectionId: input.connectionId,
      workspaceContext: input.workspaceContext,
    });
    const ts = this.now();
    const hostEvidence: Evidence = {
      kind: 'host_observation',
      observedAt: ts,
      reasonCode: 'teamwork_launch_attempt',
    };

    if (!this.gates.teamworkEnabled) {
      this.appendTrace(state, {
        eventKind: 'launch_blocked',
        summary: 'Teamwork 功能门控已关闭，已阻断发起并保持历史只读',
        reasonCode: 'teamwork_feature_disabled',
        evidence: hostEvidence,
      });
      return {
        accepted: false,
        code: 'TEAMWORK_DISABLED',
        message: 'Teamwork feature gate is disabled; observed history remains read-only.',
      };
    }

    if (isLegacyTeamworkPreviewCommand(input.rawCommand)) {
      state.commandDiscovery = 'legacy_preview_unverified';
      this.bumpRevision(state);
      this.appendTrace(state, {
        eventKind: 'launch_blocked',
        summary: '拒绝旧命令名 /teamwork-preview：不假定 preview 命令可用',
        reasonCode: 'legacy_teamwork_preview_rejected',
        evidence: hostEvidence,
      });
      return {
        accepted: false,
        code: 'LEGACY_PREVIEW_COMMAND_REJECTED',
        message:
          'Legacy /teamwork-preview is not assumed available; use verified /teamwork advertisement only.',
      };
    }

    if (!isCanonicalTeamworkCommand(input.rawCommand)) {
      return {
        accepted: false,
        code: 'INVALID_COMMAND',
        message: 'Only canonical /teamwork command is accepted by the Teamwork observer.',
      };
    }

    if (state.commandDiscovery === 'not_advertised') {
      this.appendTrace(state, {
        eventKind: 'launch_blocked',
        summary: '当前会话未广告 /teamwork，阻断发起',
        reasonCode: 'teamwork_not_advertised',
        evidence: hostEvidence,
      });
      return {
        accepted: false,
        code: 'COMMAND_NOT_ADVERTISED',
        message: '/teamwork is not advertised on the active ACP binding.',
      };
    }

    state.phase = 'launch_pending_evidence';
    state.workflowState = {
      kind: 'known',
      value: 'queued',
      evidence: hostEvidence,
    };
    if (input.scopingActivityId) {
      state.scopingActivityId = input.scopingActivityId;
    } else if (!state.scopingActivityId) {
      state.scopingActivityId = asActivityId(`act_tw_scope_${state.binding.runtimeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    }
    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'launch_requested',
      summary: '已发送 /teamwork 请求，等待原生访谈或协议确认',
      entityId: state.workflowId,
      reasonCode: 'launch_accepted_awaiting_native_evidence',
      evidence: hostEvidence,
    });

    return {
      accepted: true,
      workflowId: state.workflowId,
      message: 'Accepted /teamwork launch; awaiting native Teamwork evidence.',
    };
  }

  /**
   * Consumes an ACP v1 `NativeIngress` frame.
   * Enforces:
   * - Generation & connection fencing
   * - Feature gate read-only protection
   * - History replay isolation (history_replay can NEVER mutate live approval gates)
   * - Post-rejection guard (rejected gate blocks project/role/milestone creation)
   */
  acceptIngressFrame(envelope: NativeIngress): { readonly accepted: boolean; readonly reasonCode: string } {
    const state = this.ensureState(envelope.binding, { connectionId: envelope.connectionId });
    const ts = this.now();

    if (!this.gates.teamworkEnabled) {
      return { accepted: false, reasonCode: 'teamwork_feature_disabled_readonly' };
    }

    if (!this.isGenerationCurrent(state, envelope.binding, envelope.connectionId)) {
      this.appendTrace(state, {
        eventKind: 'generation_fenced',
        summary: '已拦截来自旧代次或旧连接的 Teamwork 入站帧',
        reasonCode: 'stale_generation_or_connection',
        evidence: {
          kind: 'host_observation',
          observedAt: ts,
          reasonCode: 'stale_generation_or_connection',
        },
      });
      return { accepted: false, reasonCode: 'stale_generation_or_connection' };
    }

    const signals = decodeTeamworkIngressSignals(envelope);
    if (signals.length === 0) {
      return { accepted: false, reasonCode: 'no_teamwork_signal' };
    }

    let appliedCount = 0;
    for (const signal of signals) {
      const evidence = buildTeamworkEvidence(envelope, `teamwork:${signal.kind}`, ts);

      if (signal.kind === 'command_catalog') {
        this.recordCommandCatalogObservation(envelope.binding, signal.advertisedCommands, evidence);
        appliedCount += 1;
        continue;
      }

      // History replay MUST NEVER mutate live approval gates or create active project actions
      if (envelope.channel === 'history_replay' && signal.kind === 'prompt_gate_decision') {
        this.appendTrace(state, {
          eventKind: 'approval_forgery_blocked',
          summary: '已拦截 history_replay 通道中的批准决定帧，禁止重放审批状态',
          reasonCode: 'history_replay_approval_blocked',
          evidence,
        });
        continue;
      }

      switch (signal.kind) {
        case 'scoping_question': {
          this.recordScopingQuestionInternal(state, {
            dedupKey: signal.dedupKey,
            toolCallId: signal.toolCallId,
            promptSummary: signal.promptSummary,
            requestKind: signal.requestKind,
            evidence,
            ts,
          });
          appliedCount += 1;
          break;
        }
        case 'prompt_artifact': {
          this.recordPromptArtifactInternal(state, {
            artifactId: signal.artifactId,
            title: signal.title,
            revision: signal.revision,
            previewExcerpt: signal.previewExcerpt,
            requiresApproval: signal.requiresApproval,
            approvalRequestId: signal.approvalRequestId,
            evidence,
            ts,
          });
          appliedCount += 1;
          break;
        }
        case 'prompt_gate_decision': {
          this.applyPromptGateDecisionInternal(state, {
            decision: signal.decision,
            artifactId: signal.artifactId,
            approvalRequestId: signal.approvalRequestId,
            reasonCode: signal.reasonCode,
            viaNativeProtocol: signal.viaNativeProtocol,
            evidence,
            ts,
          });
          appliedCount += 1;
          break;
        }
        case 'project_scope': {
          if (this.blockPostRejectionOrUnapprovedMutation(state, 'project_scope', evidence)) {
            continue;
          }
          this.recordProjectScopeInternal(state, {
            projectLabel: signal.projectLabel,
            nativeProjectPath: signal.nativeProjectPath,
            pathSource: 'native_event',
            evidence,
          });
          appliedCount += 1;
          break;
        }
        case 'role_event': {
          if (this.blockPostRejectionOrUnapprovedMutation(state, 'role_event', evidence)) {
            continue;
          }
          this.recordRoleEventInternal(state, {
            roleKind: signal.roleKind,
            displayLabel: signal.displayLabel,
            wireChildSessionId: signal.wireChildSessionId,
            toolCallId: signal.toolCallId,
            agentIdHint: signal.agentIdHint,
            milestoneId: signal.milestoneId,
            evidence,
          });
          appliedCount += 1;
          break;
        }
        case 'milestone_update': {
          if (this.blockPostRejectionOrUnapprovedMutation(state, 'milestone_update', evidence)) {
            continue;
          }
          this.recordMilestoneInternal(state, {
            milestoneId: signal.milestoneId,
            label: signal.label,
            milestoneState: signal.state,
            outcome: signal.outcome,
            after: signal.after,
            agentIds: signal.agentIds,
            summary: signal.summary,
            evidence,
          });
          appliedCount += 1;
          break;
        }
        case 'audit_update': {
          if (this.blockPostRejectionOrUnapprovedMutation(state, 'audit_update', evidence)) {
            continue;
          }
          this.recordAuditInternal(state, {
            auditId: signal.auditId,
            milestoneId: signal.milestoneId,
            label: signal.label,
            verdict: signal.verdict,
            auditorAgentId: signal.auditorAgentId,
            artifactId: signal.artifactId,
            summary: signal.summary,
            evidence,
            ts,
          });
          appliedCount += 1;
          break;
        }
        case 'artifact_ref': {
          if (
            signal.category !== 'prompt_artifact' &&
            this.blockPostRejectionOrUnapprovedMutation(state, 'artifact_ref', evidence)
          ) {
            continue;
          }
          this.recordArtifactInternal(state, {
            artifactId: signal.artifactId,
            title: signal.title,
            category: signal.category,
            artifactKind: signal.artifactKind,
            milestoneId: signal.milestoneId,
            ownerAgentId: signal.ownerAgentId,
            revision: signal.revision,
            evidence,
            ts,
          });
          appliedCount += 1;
          break;
        }
      }
    }

    return {
      accepted: appliedCount > 0,
      reasonCode: appliedCount > 0 ? 'teamwork_signal_applied' : 'teamwork_signal_blocked',
    };
  }

  /**
   * Consumes an NP-07 typed request/receipt for either a Teamwork scoping question
   * or a formal Prompt Artifact native approval request.
   */
  acceptRequestReceipt(input: TeamworkRequestReceiptInput): {
    readonly applied: boolean;
    readonly deduplicated: boolean;
    readonly reasonCode: string;
  } {
    const state = this.ensureState(input.binding);
    const ts = this.now();

    if (!this.gates.teamworkEnabled) {
      return {
        applied: false,
        deduplicated: false,
        reasonCode: 'teamwork_feature_disabled_readonly',
      };
    }

    if (!this.isGenerationCurrent(state, input.binding)) {
      return {
        applied: false,
        deduplicated: false,
        reasonCode: 'stale_generation',
      };
    }

    const evidence: Evidence = input.evidence ?? {
      kind: 'host_observation',
      observedAt: input.request.updatedAt || ts,
      reasonCode: `np07_receipt:${input.request.receiptState}`,
    };

    if (input.stage === 'scoping') {
      const existingKey =
        state.scopingKeyByApprovalId.get(input.request.approvalId) ??
        (input.dedupKey && state.scopingQuestions.has(input.dedupKey) ? input.dedupKey : undefined);
      const dedupKey = existingKey ?? input.dedupKey ?? `approval:${input.request.approvalId}`;
      const existing = state.scopingQuestions.get(dedupKey);

      if (existing) {
        state.scopingKeyByApprovalId.set(input.request.approvalId, dedupKey);
        existing.approvalId = input.request.approvalId;

        // Idempotency guard: never regress a terminal receipt back to pending on duplicate delivery!
        if (input.request.receiptState === 'pending' && existing.receiptState === 'pending') {
          existing.duplicateDeliveriesIgnored += 1;
          return {
            applied: false,
            deduplicated: true,
            reasonCode: 'scoping_question_duplicate_ignored',
          };
        }
        if (isTerminalReceipt(existing.receiptState) && input.request.receiptState === 'pending') {
          existing.duplicateDeliveriesIgnored += 1;
          return {
            applied: false,
            deduplicated: true,
            reasonCode: 'scoping_question_terminal_preserved',
          };
        }

        existing.receiptState = input.request.receiptState;
        if (input.request.receiptId) existing.receiptId = input.request.receiptId;
        if (input.selectedOptionLabel) {
          existing.selectedOptionLabel = sanitizeLabel(input.selectedOptionLabel, '已选择选项', 240);
        }
        existing.evidence = evidence;
        existing.updatedAt = ts;
        this.bumpRevision(state);
        this.appendTrace(state, {
          eventKind: 'scoping_receipt',
          summary: `访谈问题 ${existing.questionId} 回执状态更新为 ${input.request.receiptState}`,
          entityId: existing.questionId,
          reasonCode: input.request.receiptState,
          evidence,
        });
        return {
          applied: true,
          deduplicated: false,
          reasonCode: 'scoping_receipt_updated',
        };
      }

      const q = this.recordScopingQuestionInternal(state, {
        dedupKey,
        approvalId: input.request.approvalId,
        promptSummary: input.promptSummary ?? 'Teamwork 需求访谈问题',
        requestKind: input.request.kind,
        receiptState: input.request.receiptState,
        receiptId: input.request.receiptId,
        selectedOptionLabel: input.selectedOptionLabel,
        evidence,
        ts,
      });
      return {
        applied: true,
        deduplicated: q.duplicateDeliveriesIgnored > 0,
        reasonCode: 'scoping_question_recorded',
      };
    }

    // stage === 'prompt_artifact_approval'
    const artifactId = input.artifactId ?? state.promptArtifact?.artifactId ?? 'art_teamwork_prompt';
    if (!state.promptArtifact) {
      this.recordPromptArtifactInternal(state, {
        artifactId,
        title: 'Teamwork Prompt Artifact',
        requiresApproval: true,
        approvalRequestId: input.request.approvalId,
        evidence,
        ts,
      });
    }

    const promptArt = state.promptArtifact!;
    promptArt.approvalRequestId = input.request.approvalId;
    if (input.request.receiptId) promptArt.approvalReceiptId = input.request.receiptId;
    promptArt.approvalReceiptState = input.request.receiptState;
    promptArt.updatedAt = ts;

    if (input.request.receiptState === 'pending') {
      const gateState: TeamworkApprovalGateState = this.gates.reviewControlEnabled
        ? 'awaiting_native_approval'
        : 'upstream_limited_manual_app';
      promptArt.reviewGate = gateState;
      state.approvalGate = gateState;
      state.phase = 'prompt_review';
      state.workflowState = { kind: 'known', value: 'requires_action', evidence };
      this.bumpRevision(state);
      return { applied: true, deduplicated: false, reasonCode: 'prompt_approval_pending' };
    }

    if (
      input.request.receiptState === 'cancelled' ||
      input.request.receiptState === 'expired' ||
      input.request.receiptState === 'connection_lost' ||
      input.request.receiptState === 'delivery_unknown'
    ) {
      const mappedGate: TeamworkApprovalGateState =
        input.request.receiptState === 'cancelled'
          ? 'cancelled'
          : input.request.receiptState === 'expired'
            ? 'expired'
            : input.request.receiptState === 'connection_lost'
              ? 'connection_lost'
              : 'delivery_unknown';
      this.applyPromptGateDecisionInternal(state, {
        decision:
          mappedGate === 'expired'
            ? 'expired'
            : mappedGate === 'cancelled'
              ? 'cancelled'
              : 'rejected',
        explicitGateOverride: mappedGate,
        artifactId: promptArt.artifactId,
        approvalRequestId: input.request.approvalId,
        reasonCode: `np07_receipt_${input.request.receiptState}`,
        viaNativeProtocol: true,
        evidence,
        ts,
      });
      return { applied: true, deduplicated: false, reasonCode: `prompt_gate_${mappedGate}` };
    }

    if (input.request.receiptState === 'response_written') {
      const decision =
        input.decisionHint === 'reject' ||
        input.selectedOptionId?.startsWith('reject') ||
        input.selectedOptionId === 'decline'
          ? 'rejected'
          : input.decisionHint === 'approve' || input.selectedOptionId?.startsWith('allow')
            ? 'approved'
            : null;

      if (decision) {
        this.applyPromptGateDecisionInternal(state, {
          decision,
          artifactId: promptArt.artifactId,
          approvalRequestId: input.request.approvalId,
          reasonCode: `np07_receipt_response_written_${decision}`,
          viaNativeProtocol: true,
          evidence,
          ts,
        });
        return { applied: true, deduplicated: false, reasonCode: `prompt_gate_${decision}` };
      }

      // Response written without explicit approve/reject hint: stay awaiting native follow-up confirmation
      promptArt.reasonCode = 'response_written_awaiting_native_confirmation';
      this.bumpRevision(state);
      return {
        applied: true,
        deduplicated: false,
        reasonCode: 'response_written_awaiting_native_confirmation',
      };
    }

    return { applied: false, deduplicated: false, reasonCode: 'receipt_state_noop' };
  }

  /**
   * Consumes an NP-05 `AgentIdentity` with explicit role attribution (Sentinel / Project Orchestrator / Auditor / Worker).
   * Unresolved or conflicting agents are NEVER promoted to confirmed Teamwork roles.
   */
  acceptAgentAttribution(input: {
    readonly binding: RuntimeBinding;
    readonly agent: AgentIdentity;
    readonly roleKind?: TeamworkRoleKind;
    readonly milestoneId?: string;
    readonly evidence: Evidence;
  }): { readonly accepted: boolean; readonly confirmed: boolean; readonly reasonCode: string } {
    const state = this.ensureState(input.binding);
    if (!this.gates.teamworkEnabled) {
      return { accepted: false, confirmed: false, reasonCode: 'teamwork_feature_disabled_readonly' };
    }
    if (!this.isGenerationCurrent(state, input.binding)) {
      return { accepted: false, confirmed: false, reasonCode: 'stale_generation' };
    }
    if (this.blockPostRejectionOrUnapprovedMutation(state, 'role_attribution', input.evidence)) {
      return { accepted: false, confirmed: false, reasonCode: 'project_creation_blocked_unapproved_gate' };
    }

    const labelStr =
      input.agent.label?.kind === 'known'
        ? input.agent.label.value
        : input.agent.role?.kind === 'known'
          ? input.agent.role.value
          : input.agent.id;
    const roleKind =
      input.roleKind ??
      classifyTeamworkRoleKind(
        input.agent.role?.kind === 'known' ? input.agent.role.value : labelStr,
      );

    const targetMap =
      input.agent.lineage === 'confirmed' ? state.confirmedRoles : state.unconfirmedRoles;
    if (input.agent.lineage === 'confirmed') {
      state.unconfirmedRoles.delete(input.agent.id);
    }

    const existing = targetMap.get(input.agent.id);
    const milestoneIds = existing?.milestoneIds ?? new Set<string>();
    if (input.milestoneId) {
      milestoneIds.add(input.milestoneId);
      const ms = state.milestones.get(input.milestoneId);
      if (ms && input.agent.lineage === 'confirmed') {
        ms.agentIds.add(input.agent.id);
      }
    }

    targetMap.set(input.agent.id, {
      agentId: input.agent.id,
      roleKind,
      displayLabel: sanitizeLabel(labelStr, input.agent.id),
      lineage: input.agent.lineage,
      foreground: input.agent.foreground,
      milestoneIds,
      evidence: input.evidence,
    });

    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'role_attributed',
      summary:
        input.agent.lineage === 'confirmed'
          ? `已证实 Teamwork 角色 ${roleKind} (${sanitizeLabel(labelStr, input.agent.id)})`
          : `记录未确证角色候选 (${input.agent.lineage})，不计入正式角色`,
      entityId: input.agent.id,
      reasonCode: input.agent.lineage === 'confirmed' ? `confirmed:${roleKind}` : `unconfirmed:${input.agent.lineage}`,
      evidence: input.evidence,
    });

    return {
      accepted: true,
      confirmed: input.agent.lineage === 'confirmed',
      reasonCode: input.agent.lineage === 'confirmed' ? 'confirmed_role_recorded' : 'unconfirmed_candidate_recorded',
    };
  }

  /**
   * Explicitly forbids forging Teamwork Prompt Artifact approval through natural language chat turns.
   */
  attemptNaturalLanguageApproval(
    binding: RuntimeBinding,
    _naturalLanguageText: string,
  ): TeamworkNaturalLanguageApprovalResult {
    const state = this.ensureState(binding);
    const ts = this.now();
    this.appendTrace(state, {
      eventKind: 'approval_forgery_blocked',
      summary: '已阻断通过自然语言消息伪造 Teamwork Prompt Artifact 批准的尝试',
      entityId: state.promptArtifact?.artifactId,
      reasonCode: 'natural_language_approval_forbidden',
      evidence: {
        kind: 'host_observation',
        observedAt: ts,
        reasonCode: 'natural_language_approval_forbidden',
      },
    });
    return {
      accepted: false,
      code: 'NATURAL_LANGUAGE_APPROVAL_FORBIDDEN',
      message:
        'Teamwork Prompt Artifact approval cannot be forged via natural language chat messages. Use verified ACP/NP-14 native approval or the official Antigravity App.',
      officialFallbackHint: OFFICIAL_TEAMWORK_APP_GUIDE,
    };
  }

  /**
   * Delegates formal native Prompt Artifact approval to NP-14 when BOTH the review control gate
   * and NP-14 native protocol capability are enabled. Fails closed otherwise.
   */
  async submitNativePromptArtifactDecision(input: {
    readonly binding: RuntimeBinding;
    readonly decision: 'approve' | 'reject';
    readonly idempotencyKey: string;
  }): Promise<TeamworkArtifactApprovalSubmissionResult> {
    const state = this.getStateForBinding(input.binding);
    if (!state || !state.promptArtifact) {
      return {
        accepted: false,
        state: 'unsupported',
        reasonCode: 'prompt_artifact_not_observed',
      };
    }
    if (!this.gates.teamworkEnabled) {
      return {
        accepted: false,
        state: 'unsupported',
        reasonCode: 'teamwork_feature_disabled_readonly',
      };
    }
    if (!this.gates.reviewControlEnabled) {
      return {
        accepted: false,
        state: 'unsupported',
        reasonCode: 'teamwork_review_control_disabled',
      };
    }
    if (!this.isGenerationCurrent(state, input.binding)) {
      return {
        accepted: false,
        state: 'conflict',
        reasonCode: 'stale_generation',
      };
    }

    const cap = this.artifactReviewPort.getReviewCapability(
      input.binding,
      state.promptArtifact.artifactId,
    );
    if (!cap.canApproveViaNativeProtocol || !this.artifactReviewPort.submitNativeArtifactApproval) {
      return {
        accepted: false,
        state: 'unsupported',
        reasonCode: cap.reasonCode,
      };
    }

    const result = await this.artifactReviewPort.submitNativeArtifactApproval({
      binding: input.binding,
      artifactId: state.promptArtifact.artifactId,
      decision: input.decision,
      requestId: state.promptArtifact.approvalRequestId,
      idempotencyKey: input.idempotencyKey,
    });

    if (result.accepted) {
      const ts = this.now();
      this.applyPromptGateDecisionInternal(state, {
        decision: input.decision === 'approve' ? 'approved' : 'rejected',
        artifactId: state.promptArtifact.artifactId,
        approvalRequestId: state.promptArtifact.approvalRequestId,
        reasonCode: `np14_native_submit:${result.reasonCode}`,
        viaNativeProtocol: true,
        evidence: {
          kind: 'host_observation',
          observedAt: ts,
          reasonCode: `np14_native_submit:${result.state}`,
        },
        ts,
      });
    }

    return result;
  }

  /**
   * Explicitly records user-authorized native project path verification (e.g. after realpath/ACL check).
   * HarnessMate NEVER creates the Teamwork project directory itself.
   */
  authorizeObservedProjectPath(
    binding: RuntimeBinding,
    opts: { readonly authorizedRoots: readonly string[]; readonly reparseCheckPassed: boolean },
  ): TeamworkPathOpenDecision {
    const state = this.getStateForBinding(binding);
    if (!state || !state.projectScope.created) {
      return {
        allowed: false,
        reasonCode: 'native_project_not_created',
        officialFallbackHint: OFFICIAL_TEAMWORK_APP_GUIDE,
      };
    }
    if (!this.gates.teamworkEnabled) {
      return {
        allowed: false,
        reasonCode: 'teamwork_feature_disabled_readonly',
        projectLabel: state.projectScope.projectLabel,
        officialFallbackHint: OFFICIAL_TEAMWORK_APP_GUIDE,
      };
    }

    state.projectScope.authorizedRoots = [...opts.authorizedRoots];
    state.projectScope.reparseCheckPassed = opts.reparseCheckPassed;
    this.bumpRevision(state);
    return this.requestAuthorizedProjectPathOpen(binding);
  }

  /**
   * Evaluates whether the observed native Teamwork project path may be opened.
   * Never leaks raw OS host paths.
   */
  requestAuthorizedProjectPathOpen(binding: RuntimeBinding): TeamworkPathOpenDecision {
    const state = this.getStateForBinding(binding);
    if (!state || !state.projectScope.created) {
      return {
        allowed: false,
        reasonCode: 'native_project_not_created',
        officialFallbackHint: OFFICIAL_TEAMWORK_APP_GUIDE,
      };
    }

    const decision = this.pathAuthorizer.evaluateProjectPath({
      binding,
      hmWorkspaceRoot: state.projectScope.hmWorkspaceRoot,
      nativeProjectPath: state.projectScope.nativeProjectPath,
      authorizedRoots: state.projectScope.authorizedRoots,
      pathSource: state.projectScope.pathSource,
      reparseCheckPassed: state.projectScope.reparseCheckPassed,
    });

    if (!decision.authorized) {
      return {
        allowed: false,
        reasonCode: decision.reasonCode,
        ...(state.projectScope.projectLabel ? { projectLabel: state.projectScope.projectLabel } : {}),
        officialFallbackHint: OFFICIAL_TEAMWORK_APP_GUIDE,
      };
    }

    return {
      allowed: true,
      reasonCode: decision.reasonCode,
      ...(state.projectScope.projectLabel ? { projectLabel: state.projectScope.projectLabel } : {}),
    };
  }

  /**
   * Handles transport disconnection:
   * - Freezes pending scoping questions & pending approval gate to `connection_lost` (no replay on reconnect).
   * - Marks active workflow & in-flight milestones as `stale`, preserving last observed values.
   */
  handleTransportClosed(binding: RuntimeBinding, connectionId: string, reason = 'transport_disconnected'): void {
    const state = this.getStateForBinding(binding);
    if (!state) return;
    if (state.activeConnectionId && state.activeConnectionId !== connectionId) return;

    const ts = this.now();
    const hostEvidence: Evidence = {
      kind: 'host_observation',
      observedAt: ts,
      reasonCode: reason,
    };

    for (const q of state.scopingQuestions.values()) {
      if (q.receiptState === 'pending' || q.receiptState === 'claimed') {
        q.receiptState = 'connection_lost';
        q.evidence = hostEvidence;
        q.updatedAt = ts;
      }
    }

    if (
      state.promptArtifact &&
      (state.promptArtifact.reviewGate === 'awaiting_native_approval' ||
        state.promptArtifact.reviewGate === 'upstream_limited_manual_app')
    ) {
      state.promptArtifact.reviewGate = 'connection_lost';
      state.promptArtifact.approvalReceiptState = 'connection_lost';
      state.promptArtifact.reasonCode = reason;
      state.promptArtifact.updatedAt = ts;
      state.approvalGate = 'connection_lost';
    }

    if (state.workflowState.kind === 'known') {
      const val = state.workflowState.value;
      if (val !== 'finished' && val !== 'failed' && val !== 'cancelled') {
        state.workflowState = {
          kind: 'stale',
          last: val,
          evidence: state.workflowState.evidence,
          reasonCode: reason,
        };
        state.phase = 'stale';
      }
    }

    for (const ms of state.milestones.values()) {
      if (ms.state.kind === 'known') {
        const val = ms.state.value;
        if (val !== 'finished' && val !== 'failed' && val !== 'cancelled') {
          ms.state = {
            kind: 'stale',
            last: val,
            evidence: ms.state.evidence,
            reasonCode: reason,
          };
        }
      }
    }

    state.activeConnectionId = null;
    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'transport_disconnected',
      summary: '原生观测连接已断开，活跃阶段与待审批项已冻结为只读/过期，不会自动重放旧授权',
      reasonCode: reason,
      evidence: hostEvidence,
    });
  }

  /**
   * Advances binding generation cleanly, fencing all frames from the previous generation.
   */
  handleGenerationChanged(prevBinding: RuntimeBinding, nextBinding: RuntimeBinding): void {
    const state = this.getStateForBinding(prevBinding);
    if (!state) return;

    const ts = this.now();
    this.handleTransportClosed(prevBinding, state.activeConnectionId ?? 'prev', 'generation_changed');
    state.binding = nextBinding;
    state.activeConnectionId = null;
    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'generation_fenced',
      summary: `运行代次已从 ${prevBinding.generation} 切换至 ${nextBinding.generation}，旧代次审批与帧已隔离`,
      reasonCode: 'generation_advanced',
      evidence: {
        kind: 'host_observation',
        observedAt: ts,
        reasonCode: 'generation_advanced',
      },
    });
  }

  /**
   * Enters reconciling state on reconnect without replaying stale approvals.
   */
  handleReconnect(
    binding: RuntimeBinding,
    connectionId: string,
    mode: 'resume' | 'load' | 'fresh',
  ): void {
    const state = this.ensureState(binding, { connectionId });
    const ts = this.now();
    state.binding = binding;
    state.activeConnectionId = connectionId;

    if (state.phase === 'stale' || state.workflowState.kind === 'stale') {
      state.phase = 'reconciling';
    }
    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'reconciling',
      summary: `已重新连接 (${mode})，等待新连接原生事件校准 Teamwork 状态（旧授权永不重放）`,
      reasonCode: `reconciling:${mode}`,
      evidence: {
        kind: 'host_observation',
        observedAt: ts,
        reasonCode: `reconciling:${mode}`,
      },
    });
  }

  // ── Internal State Mutators ──────────────────────────────────────────

  private blockPostRejectionOrUnapprovedMutation(
    state: InternalTeamworkBindingState,
    attemptedKind: string,
    evidence: Evidence,
  ): boolean {
    if (isGateRejectedOrClosed(state.approvalGate)) {
      this.appendTrace(state, {
        eventKind: 'approval_gate',
        summary: `Prompt Artifact 已被拒绝/取消，已阻断后续 ${attemptedKind} 创建项目或里程碑`,
        reasonCode: 'post_rejection_mutation_blocked',
        evidence,
      });
      return true;
    }
    if (state.approvalGate !== 'approved') {
      this.appendTrace(state, {
        eventKind: 'approval_gate',
        summary: `Prompt Artifact 尚未经原生协议正式批准，已阻断 ${attemptedKind} 提前创建项目实体`,
        reasonCode: 'unapproved_gate_mutation_blocked',
        evidence,
      });
      return true;
    }
    return false;
  }

  private recordScopingQuestionInternal(
    state: InternalTeamworkBindingState,
    params: {
      readonly dedupKey: string;
      readonly approvalId?: string;
      readonly toolCallId?: string;
      readonly promptSummary: string;
      readonly requestKind: 'question' | 'elicitation' | 'permission';
      readonly receiptState?: NativeRequestReceiptState;
      readonly receiptId?: string;
      readonly selectedOptionLabel?: string;
      readonly evidence: Evidence;
      readonly ts: number;
    },
  ): InternalScopingQuestion {
    const mappedByTool = params.toolCallId
      ? state.scopingKeyByToolCallId.get(params.toolCallId)
      : undefined;
    const mappedByApproval = params.approvalId
      ? state.scopingKeyByApprovalId.get(params.approvalId)
      : undefined;
    const effectiveKey = mappedByApproval ?? mappedByTool ?? params.dedupKey;
    const existing = state.scopingQuestions.get(effectiveKey);

    if (existing) {
      existing.duplicateDeliveriesIgnored += 1;
      if (params.approvalId) {
        existing.approvalId = params.approvalId;
        state.scopingKeyByApprovalId.set(params.approvalId, effectiveKey);
      }
      if (params.toolCallId) {
        state.scopingKeyByToolCallId.set(params.toolCallId, effectiveKey);
      }
      return existing;
    }

    const questionId = `tw_q_${state.nextQuestionSeq++}`;
    const entry: InternalScopingQuestion = {
      questionId,
      ...(params.approvalId ? { approvalId: params.approvalId } : {}),
      dedupKey: effectiveKey,
      ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      promptSummary: sanitizeLabel(params.promptSummary, 'Teamwork 需求访谈问题', 600),
      requestKind: params.requestKind,
      receiptState: params.receiptState ?? 'pending',
      ...(params.receiptId ? { receiptId: params.receiptId } : {}),
      ...(params.selectedOptionLabel
        ? { selectedOptionLabel: sanitizeLabel(params.selectedOptionLabel, '已选择选项', 240) }
        : {}),
      occurrence: state.scopingQuestions.size + 1,
      duplicateDeliveriesIgnored: 0,
      evidence: params.evidence,
      updatedAt: params.ts,
    };

    state.scopingQuestions.set(effectiveKey, entry);
    if (params.approvalId) state.scopingKeyByApprovalId.set(params.approvalId, effectiveKey);
    if (params.toolCallId) state.scopingKeyByToolCallId.set(params.toolCallId, effectiveKey);

    if (!state.scopingActivityId) {
      state.scopingActivityId = asActivityId(`act_tw_scope_${state.binding.runtimeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    }
    if (state.phase === 'idle' || state.phase === 'launch_pending_evidence' || state.phase === 'reconciling') {
      state.phase = 'scoping';
    }
    state.workflowState = {
      kind: 'known',
      value: entry.receiptState === 'pending' ? 'requires_action' : 'running',
      evidence: params.evidence,
    };
    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'scoping_question',
      summary: `记录访谈问题 #${entry.occurrence}：${entry.promptSummary}`,
      entityId: questionId,
      reasonCode: entry.receiptState,
      evidence: params.evidence,
    });
    return entry;
  }

  private recordPromptArtifactInternal(
    state: InternalTeamworkBindingState,
    params: {
      readonly artifactId: string;
      readonly title: string;
      readonly revision?: number;
      readonly previewExcerpt?: string;
      readonly requiresApproval: boolean;
      readonly approvalRequestId?: string;
      readonly evidence: Evidence;
      readonly ts: number;
    },
  ): void {
    const cap = this.artifactReviewPort.getReviewCapability(state.binding, params.artifactId);
    const summaryFromPort = this.artifactReviewPort.readArtifactSummary(
      state.binding,
      params.artifactId,
    );

    const canApprove = this.gates.reviewControlEnabled && cap.canApproveViaNativeProtocol;
    const reviewGate: TeamworkApprovalGateState = !params.requiresApproval
      ? 'not_reached'
      : canApprove
        ? 'awaiting_native_approval'
        : 'upstream_limited_manual_app';

    const nextRevision =
      params.revision ??
      summaryFromPort?.revision ??
      (state.promptArtifact ? state.promptArtifact.revision + 1 : 1);

    state.promptArtifact = {
      artifactId: params.artifactId,
      title: sanitizeLabel(summaryFromPort?.title ?? params.title, 'Teamwork Prompt Artifact', 200),
      revision: nextRevision,
      reviewGate,
      ...(params.approvalRequestId ? { approvalRequestId: params.approvalRequestId } : {}),
      reasonCode: canApprove ? 'native_prompt_approval_ready' : cap.reasonCode,
      ...(params.previewExcerpt ?? summaryFromPort?.previewExcerpt
        ? {
            previewExcerpt: sanitizeLabel(
              (params.previewExcerpt ?? summaryFromPort?.previewExcerpt)!,
              '[redacted artifact preview]',
              1200,
            ),
          }
        : {}),
      evidence: params.evidence,
      updatedAt: params.ts,
    };

    state.approvalGate = reviewGate;
    state.phase = 'prompt_review';
    state.workflowState = {
      kind: 'known',
      value: 'requires_action',
      evidence: params.evidence,
    };

    this.recordArtifactInternal(state, {
      artifactId: params.artifactId,
      title: state.promptArtifact.title,
      category: 'prompt_artifact',
      artifactKind: summaryFromPort?.artifactKind ?? 'markdown',
      revision: nextRevision,
      evidence: params.evidence,
      ts: params.ts,
    });

    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'prompt_artifact',
      summary: `已生成 Prompt Artifact (${params.artifactId})，审阅门控：${reviewGate}`,
      entityId: params.artifactId,
      reasonCode: state.promptArtifact.reasonCode,
      evidence: params.evidence,
    });
  }

  private applyPromptGateDecisionInternal(
    state: InternalTeamworkBindingState,
    params: {
      readonly decision: 'approved' | 'rejected' | 'cancelled' | 'expired';
      readonly explicitGateOverride?: TeamworkApprovalGateState;
      readonly artifactId?: string;
      readonly approvalRequestId?: string;
      readonly reasonCode?: string;
      readonly viaNativeProtocol: boolean;
      readonly evidence: Evidence;
      readonly ts: number;
    },
  ): void {
    if (params.decision === 'approved' && !params.viaNativeProtocol) {
      this.appendTrace(state, {
        eventKind: 'approval_forgery_blocked',
        summary: '拒绝未通过原生协议验证的批准信号',
        entityId: params.artifactId ?? state.promptArtifact?.artifactId,
        reasonCode: 'unverified_approval_channel_blocked',
        evidence: params.evidence,
      });
      return;
    }

    const nextGate: TeamworkApprovalGateState =
      params.explicitGateOverride ??
      (params.decision === 'approved'
        ? 'approved'
        : params.decision === 'expired'
          ? 'expired'
          : params.decision === 'cancelled'
            ? 'cancelled'
            : 'rejected');

    state.approvalGate = nextGate;
    if (state.promptArtifact) {
      state.promptArtifact.reviewGate = nextGate;
      if (params.approvalRequestId) state.promptArtifact.approvalRequestId = params.approvalRequestId;
      state.promptArtifact.reasonCode = params.reasonCode ?? nextGate;
      state.promptArtifact.updatedAt = params.ts;
    }

    if (nextGate === 'approved') {
      state.phase = 'project_active';
      state.workflowState = {
        kind: 'known',
        value: 'running',
        evidence: params.evidence,
      };
    } else if (nextGate === 'connection_lost' || nextGate === 'delivery_unknown') {
      state.phase = 'stale';
      state.workflowState = {
        kind: 'stale',
        last: 'requires_action',
        evidence: params.evidence,
        reasonCode: params.reasonCode ?? nextGate,
      };
    } else {
      // Rejected / Cancelled / Expired: strictly guarantee zero project/roles/milestones exist!
      state.phase = nextGate === 'rejected' ? 'rejected' : 'cancelled';
      state.workflowState = {
        kind: 'known',
        value: 'cancelled',
        evidence: params.evidence,
      };
      state.projectScope.created = false;
      state.projectScope.projectScopeId = undefined;
      state.projectScope.projectLabel = undefined;
      state.projectScope.nativeProjectPath = undefined;
      state.confirmedRoles.clear();
      state.unconfirmedRoles.clear();
      state.milestones.clear();
      state.auditGates.clear();
    }

    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'approval_gate',
      summary:
        nextGate === 'approved'
          ? 'Prompt Artifact 已通过原生协议正式批准，进入 Teamwork 项目执行阶段'
          : `Prompt Artifact 批准门控结束（${nextGate}）：未创建 Teamwork 项目目录、角色或里程碑`,
      entityId: state.promptArtifact?.artifactId,
      reasonCode: params.reasonCode ?? nextGate,
      evidence: params.evidence,
    });
  }

  private recordProjectScopeInternal(
    state: InternalTeamworkBindingState,
    params: {
      readonly projectLabel?: string;
      readonly nativeProjectPath?: string;
      readonly pathSource: 'native_event' | 'authorized_user_selection' | 'unknown';
      readonly evidence: Evidence;
    },
  ): void {
    const authDecision = this.pathAuthorizer.evaluateProjectPath({
      binding: state.binding,
      hmWorkspaceRoot: state.projectScope.hmWorkspaceRoot,
      nativeProjectPath: params.nativeProjectPath ?? state.projectScope.nativeProjectPath,
      authorizedRoots: state.projectScope.authorizedRoots,
      pathSource: params.pathSource,
      reparseCheckPassed: state.projectScope.reparseCheckPassed,
    });

    state.projectScope.created = true;
    state.projectScope.projectScopeId =
      state.projectScope.projectScopeId ??
      `tw_proj_${state.binding.runtimeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const safeLabel =
      (params.projectLabel && sanitizeLabel(params.projectLabel, '', 160)) ||
      authDecision.safeProjectLabel ||
      state.projectScope.projectLabel ||
      'Teamwork Native Project';
    state.projectScope.projectLabel = safeLabel;
    if (params.nativeProjectPath) {
      // Stored strictly server-side; never copied into public DTO
      state.projectScope.nativeProjectPath = params.nativeProjectPath;
      state.projectScope.pathSource = params.pathSource;
    }
    state.projectScope.evidence = params.evidence;
    if (state.phase === 'reconciling' || state.phase === 'stale') {
      state.phase = 'project_active';
    }

    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'project_scope',
      summary: `已观测到原生 Teamwork 项目「${safeLabel}」（与 HM 工作区分离，路径授权状态：${authDecision.pathAccessGate}）`,
      entityId: state.projectScope.projectScopeId,
      reasonCode: authDecision.reasonCode,
      evidence: params.evidence,
    });
  }

  private recordRoleEventInternal(
    state: InternalTeamworkBindingState,
    params: {
      readonly roleKind: TeamworkRoleKind;
      readonly displayLabel: string;
      readonly wireChildSessionId?: string;
      readonly toolCallId?: string;
      readonly agentIdHint?: NativeAgentId;
      readonly milestoneId?: string;
      readonly evidence: Evidence;
    },
  ): void {
    const resolved = this.childLineagePort?.resolveRoleAgent({
      binding: state.binding,
      agentId: params.agentIdHint,
      wireChildSessionId: params.wireChildSessionId,
      toolCallId: params.toolCallId,
    });

    if (resolved && resolved.lineage === 'confirmed') {
      const existing = state.confirmedRoles.get(resolved.agentId);
      const milestoneIds = existing?.milestoneIds ?? new Set<string>();
      if (params.milestoneId) {
        milestoneIds.add(params.milestoneId);
        state.milestones.get(params.milestoneId)?.agentIds.add(resolved.agentId);
      }
      state.confirmedRoles.set(resolved.agentId, {
        agentId: resolved.agentId,
        roleKind: params.roleKind,
        displayLabel: sanitizeLabel(resolved.displayLabel ?? params.displayLabel, resolved.agentId),
        lineage: 'confirmed',
        foreground: { kind: 'known', value: resolved.foreground, evidence: resolved.evidence },
        milestoneIds,
        evidence: params.evidence,
      });
      this.bumpRevision(state);
      this.appendTrace(state, {
        eventKind: 'role_attributed',
        summary: `经 NP-05 亲缘证实 Teamwork 角色：${params.roleKind} (${sanitizeLabel(params.displayLabel, resolved.agentId)})`,
        entityId: resolved.agentId,
        reasonCode: `confirmed:${params.roleKind}`,
        evidence: params.evidence,
      });
      return;
    }

    // Unverified candidate: never promote into confirmedRoles!
    const candidateId =
      resolved?.agentId ??
      params.agentIdHint ??
      asNativeAgentId(`agt_tw_cand_${state.nextCandidateAgentSeq++}`);
    const existing = state.unconfirmedRoles.get(candidateId);
    const milestoneIds = existing?.milestoneIds ?? new Set<string>();
    if (params.milestoneId) milestoneIds.add(params.milestoneId);

    state.unconfirmedRoles.set(candidateId, {
      agentId: candidateId,
      roleKind: params.roleKind,
      displayLabel: sanitizeLabel(params.displayLabel, candidateId),
      lineage: resolved?.lineage ?? 'unresolved',
      foreground: { kind: 'unknown', reasonCode: 'role_lineage_unconfirmed' },
      milestoneIds,
      evidence: params.evidence,
    });
    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'role_attributed',
      summary: `观测到未确证亲缘的角色候选 ${params.roleKind}，保留在候选区`,
      entityId: candidateId,
      reasonCode: 'role_lineage_unconfirmed',
      evidence: params.evidence,
    });
  }

  private recordMilestoneInternal(
    state: InternalTeamworkBindingState,
    params: {
      readonly milestoneId: string;
      readonly label: string;
      readonly milestoneState: WorkState;
      readonly outcome?: WorkOutcome;
      readonly after?: readonly string[];
      readonly agentIds?: readonly NativeAgentId[];
      readonly summary?: string;
      readonly evidence: Evidence;
    },
  ): void {
    const existing = state.milestones.get(params.milestoneId);
    const agentIds = existing?.agentIds ?? new Set<NativeAgentId>();
    for (const id of params.agentIds ?? []) {
      if (state.confirmedRoles.has(id)) {
        agentIds.add(id);
      }
    }

    const entry: InternalMilestoneEntry = {
      id: params.milestoneId,
      label: sanitizeLabel(params.label, params.milestoneId, 200),
      state: { kind: 'known', value: params.milestoneState, evidence: params.evidence },
      ...(params.outcome
        ? { outcome: { kind: 'known', value: params.outcome, evidence: params.evidence } }
        : existing?.outcome
          ? { outcome: existing.outcome }
          : {}),
      ...(params.after ? { after: [...params.after] } : existing?.after ? { after: existing.after } : {}),
      agentIds,
      ...(params.summary
        ? { summary: sanitizeLabel(params.summary, '', 600) }
        : existing?.summary
          ? { summary: existing.summary }
          : {}),
      auditIds: existing?.auditIds ?? new Set<string>(),
      artifactIds: existing?.artifactIds ?? new Set<string>(),
    };

    state.milestones.set(params.milestoneId, entry);

    if (params.milestoneState === 'failed') {
      state.phase = 'failed';
      state.workflowState = { kind: 'known', value: 'failed', evidence: params.evidence };
    } else if (params.milestoneState === 'cancelled') {
      state.phase = 'cancelled';
      state.workflowState = { kind: 'known', value: 'cancelled', evidence: params.evidence };
    } else {
      state.phase = 'project_active';
      state.workflowState = { kind: 'known', value: 'running', evidence: params.evidence };
    }

    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'milestone_updated',
      summary: `里程碑 ${entry.label} 状态更新为 ${params.milestoneState}${params.outcome ? ` (${params.outcome})` : ''}`,
      entityId: params.milestoneId,
      reasonCode: params.milestoneState,
      evidence: params.evidence,
    });
  }

  private recordAuditInternal(
    state: InternalTeamworkBindingState,
    params: {
      readonly auditId: string;
      readonly milestoneId?: string;
      readonly label: string;
      readonly verdict: 'pending' | 'passed' | 'changes_requested' | 'failed' | 'cancelled' | 'unknown';
      readonly auditorAgentId?: NativeAgentId;
      readonly artifactId?: string;
      readonly summary?: string;
      readonly evidence: Evidence;
      readonly ts: number;
    },
  ): void {
    const confirmedAuditor =
      params.auditorAgentId && state.confirmedRoles.has(params.auditorAgentId)
        ? params.auditorAgentId
        : undefined;

    state.auditGates.set(params.auditId, {
      auditId: params.auditId,
      ...(params.milestoneId ? { milestoneId: params.milestoneId } : {}),
      label: sanitizeLabel(params.label, 'Teamwork Audit Gate', 200),
      verdict: params.verdict,
      ...(confirmedAuditor ? { auditorAgentId: confirmedAuditor } : {}),
      ...(params.artifactId ? { artifactId: params.artifactId } : {}),
      ...(params.summary ? { summary: sanitizeLabel(params.summary, '', 600) } : {}),
      evidence: params.evidence,
      updatedAt: params.ts,
    });

    if (params.milestoneId) {
      state.milestones.get(params.milestoneId)?.auditIds.add(params.auditId);
    }

    if (params.verdict === 'pending') {
      state.phase = 'auditing';
    }

    this.bumpRevision(state);
    this.appendTrace(state, {
      eventKind: 'audit_updated',
      summary: `审计门控 ${sanitizeLabel(params.label, params.auditId)}：${params.verdict}`,
      entityId: params.auditId,
      reasonCode: params.verdict,
      evidence: params.evidence,
    });
  }

  private recordArtifactInternal(
    state: InternalTeamworkBindingState,
    params: {
      readonly artifactId: string;
      readonly title: string;
      readonly category: TeamworkArtifactCategory;
      readonly artifactKind: 'markdown' | 'text' | 'diff' | 'script' | 'json' | 'media' | 'unknown';
      readonly milestoneId?: string;
      readonly ownerAgentId?: NativeAgentId;
      readonly activityId?: ActivityId;
      readonly revision?: number;
      readonly evidence: Evidence;
      readonly ts: number;
    },
  ): void {
    const existing = state.artifacts.get(params.artifactId);
    const confirmedOwner =
      params.ownerAgentId && state.confirmedRoles.has(params.ownerAgentId)
        ? params.ownerAgentId
        : undefined;

    state.artifacts.set(params.artifactId, {
      artifactId: params.artifactId,
      title: sanitizeLabel(params.title, params.artifactId, 200),
      category: params.category,
      artifactKind: params.artifactKind,
      ...(params.milestoneId ? { milestoneId: params.milestoneId } : {}),
      ...(confirmedOwner ? { ownerAgentId: confirmedOwner } : {}),
      ...(params.activityId ? { activityId: params.activityId } : {}),
      revision: params.revision ?? (existing ? existing.revision + 1 : 1),
      updatedAt: params.ts,
      evidence: params.evidence,
    });

    if (params.milestoneId) {
      state.milestones.get(params.milestoneId)?.artifactIds.add(params.artifactId);
    }
  }

  // ── Public Entity, Projection, Registry Commit & Resource Reader ─────

  /**
   * Builds a strictly validated `@harnessmate/protocol` `NativeWorkflow` (`kind: 'teamwork'`).
   * Omits `milestones` when zero milestones have been observed (honest empty chart hiding).
   */
  getWorkflowEntity(binding: RuntimeBinding): NativeWorkflow | null {
    const state = this.getStateForBinding(binding);
    if (!state) return null;

    const milestones: NativeStage[] = Array.from(state.milestones.values()).map((ms) => ({
      id: ms.id,
      label: ms.label,
      state: ms.state,
      ...(ms.after && ms.after.length > 0 ? { after: [...ms.after] } : {}),
      ...(ms.agentIds.size > 0 ? { agentIds: Array.from(ms.agentIds) } : {}),
    }));

    return NativeWorkflowSchema.parse({
      id: state.workflowId,
      originActivityId: state.originActivityId,
      state: state.workflowState,
      detail: {
        kind: 'teamwork',
        ...(state.scopingActivityId ? { scopingActivityId: state.scopingActivityId } : {}),
        ...(state.promptArtifact ? { promptArtifactId: state.promptArtifact.artifactId } : {}),
        ...(state.projectScope.created && state.projectScope.projectLabel
          ? { projectLabel: state.projectScope.projectLabel }
          : {}),
        ...(milestones.length > 0 ? { milestones } : {}),
      },
      revision: state.revision,
    });
  }

  /**
   * Atomically commits the current `NativeWorkflow` entity (and server-side native project path alias,
   * if any) into `AgyNativeRuntimeRegistry` without altering shared protocol schemas.
   */
  commitToRegistry(
    registry: AgyNativeRuntimeRegistry,
    binding: RuntimeBinding,
  ): { readonly committed: boolean; readonly workflowId?: WorkflowId } {
    const state = this.getStateForBinding(binding);
    const workflow = this.getWorkflowEntity(binding);
    if (!state || !workflow) return { committed: false };

    const ts = this.now();
    const aliases: Array<{
      readonly targetEntityKind: 'workflow';
      readonly targetEntityId: string;
      readonly alias: NativeAlias;
    }> = [];

    if (state.projectScope.created && state.projectScope.nativeProjectPath && state.projectScope.evidence) {
      aliases.push({
        targetEntityKind: 'workflow',
        targetEntityId: workflow.id,
        alias: {
          namespace: 'workflow',
          nativeValue: `teamwork_project:${state.projectScope.projectScopeId ?? workflow.id}`,
          evidence: state.projectScope.evidence,
        },
      });
    }

    const resourceIds = Array.from(state.artifacts.keys());

    registry.commitAndPublish(
      binding,
      {
        workflows: [workflow],
        ...(aliases.length > 0 ? { aliases } : {}),
      },
      {
        type: 'native.workflow.changed',
        turnId: null,
        payload: {
          workflow: sanitizeNativeWorkflowForPublic(workflow, ts),
          ...(resourceIds.length > 0 ? { resourceIds } : {}),
        },
        mutationKey: `teamwork:${workflow.id}:rev:${workflow.revision}`,
        createdAt: ts,
      },
    );

    return { committed: true, workflowId: workflow.id };
  }

  /**
   * Produces a strictly sanitized, Zod-validated `TeamworkWorkbenchProjectionDto`.
   * Guaranteed to contain zero raw host paths, zero tokens, and zero internal connectionIds.
   */
  getPublicProjection(
    binding: RuntimeBinding,
    nowMs = this.now(),
  ): TeamworkWorkbenchProjectionDto | null {
    const state = this.getStateForBinding(binding);
    if (!state) return null;

    const readOnly =
      !this.gates.teamworkEnabled ||
      state.phase === 'stale' ||
      state.phase === 'rejected' ||
      state.phase === 'cancelled' ||
      state.phase === 'finished';

    const readOnlyReasonCode = !this.gates.teamworkEnabled
      ? 'teamwork_feature_disabled_readonly'
      : state.phase === 'stale'
        ? 'transport_disconnected_readonly'
        : state.phase === 'rejected'
          ? 'prompt_artifact_rejected_readonly'
          : !this.gates.reviewControlEnabled && state.phase === 'prompt_review'
            ? 'teamwork_review_control_disabled'
            : undefined;

    const pathAuth = this.pathAuthorizer.evaluateProjectPath({
      binding,
      hmWorkspaceRoot: state.projectScope.hmWorkspaceRoot,
      nativeProjectPath: state.projectScope.nativeProjectPath,
      authorizedRoots: state.projectScope.authorizedRoots,
      pathSource: state.projectScope.pathSource,
      reparseCheckPassed: state.projectScope.reparseCheckPassed,
    });

    const projectScope: TeamworkProjectScopeDto = {
      hmWorkspace: {
        ...(state.projectScope.hmWorkspaceId ? { workspaceId: state.projectScope.hmWorkspaceId } : {}),
        label: state.projectScope.hmWorkspaceLabel,
        isolatedFromNativeProject: true,
      },
      nativeProject: {
        created: state.projectScope.created,
        ...(state.projectScope.created && state.projectScope.projectScopeId
          ? { projectScopeId: state.projectScope.projectScopeId }
          : {}),
        ...(state.projectScope.created && state.projectScope.projectLabel
          ? { projectLabel: state.projectScope.projectLabel }
          : {}),
        scopeRelationship: state.projectScope.created ? pathAuth.scopeRelationship : 'unverified',
        pathAccessGate: state.projectScope.created ? pathAuth.pathAccessGate : 'unavailable',
        pathOpenAuthorized: state.projectScope.created && this.gates.teamworkEnabled && pathAuth.authorized,
        authorizationReasonCode: state.projectScope.created
          ? pathAuth.reasonCode
          : 'native_project_not_created',
        ...(state.projectScope.created && state.projectScope.evidence
          ? { evidence: toPublicEvidenceDto(state.projectScope.evidence, nowMs) }
          : {}),
      },
    };

    const promptArtifact: TeamworkPromptArtifactDto | null = state.promptArtifact
      ? (() => {
          const cap = this.artifactReviewPort.getReviewCapability(
            binding,
            state.promptArtifact.artifactId,
          );
          const canApprove =
            this.gates.teamworkEnabled &&
            this.gates.reviewControlEnabled &&
            cap.canApproveViaNativeProtocol &&
            state.promptArtifact.reviewGate === 'awaiting_native_approval';
          return {
            artifactId: state.promptArtifact.artifactId,
            title: state.promptArtifact.title,
            revision: state.promptArtifact.revision,
            reviewGate: state.promptArtifact.reviewGate,
            canApproveViaNativeProtocol: canApprove,
            reviewControlEnabled: this.gates.teamworkEnabled && this.gates.reviewControlEnabled,
            ...(state.promptArtifact.approvalRequestId
              ? { approvalRequestId: state.promptArtifact.approvalRequestId }
              : {}),
            ...(state.promptArtifact.approvalReceiptId
              ? { approvalReceiptId: state.promptArtifact.approvalReceiptId }
              : {}),
            ...(state.promptArtifact.approvalReceiptState
              ? { approvalReceiptState: state.promptArtifact.approvalReceiptState }
              : {}),
            ...(state.promptArtifact.reasonCode
              ? { reasonCode: state.promptArtifact.reasonCode }
              : {}),
            officialFallbackHint: cap.officialFallbackHint,
            ...(state.promptArtifact.previewExcerpt
              ? { previewExcerpt: state.promptArtifact.previewExcerpt }
              : {}),
            evidence: toPublicEvidenceDto(state.promptArtifact.evidence, nowMs),
            updatedAt: state.promptArtifact.updatedAt,
          };
        })()
      : null;

    const scopingQuestions: TeamworkScopingQuestionDto[] = Array.from(
      state.scopingQuestions.values(),
    ).map((q) => ({
      questionId: q.questionId,
      ...(q.approvalId ? { approvalId: q.approvalId } : {}),
      dedupKey: q.dedupKey,
      promptSummary: q.promptSummary,
      requestKind: q.requestKind,
      receiptState: q.receiptState,
      ...(q.receiptId ? { receiptId: q.receiptId } : {}),
      ...(q.selectedOptionLabel ? { selectedOptionLabel: q.selectedOptionLabel } : {}),
      occurrence: q.occurrence,
      duplicateDeliveriesIgnored: q.duplicateDeliveriesIgnored,
      evidence: toPublicEvidenceDto(q.evidence, nowMs),
      updatedAt: q.updatedAt,
    }));

    const mapRole = (entry: InternalRoleEntry): TeamworkRoleAttributionDto => ({
      agentId: entry.agentId,
      roleKind: entry.roleKind,
      displayLabel: entry.displayLabel,
      lineage: entry.lineage,
      foreground: sanitizeObservedForPublic(entry.foreground, nowMs),
      milestoneIds: Array.from(entry.milestoneIds),
      evidence: toPublicEvidenceDto(entry.evidence, nowMs),
    });

    const milestones: TeamworkMilestoneDetailDto[] = Array.from(state.milestones.values()).map(
      (ms) => ({
        stage: {
          id: ms.id,
          label: ms.label,
          state: sanitizeObservedForPublic(ms.state, nowMs),
          ...(ms.after && ms.after.length > 0 ? { after: [...ms.after] } : {}),
          ...(ms.agentIds.size > 0 ? { agentIds: Array.from(ms.agentIds) } : {}),
        },
        ...(ms.outcome ? { outcome: sanitizeObservedForPublic(ms.outcome, nowMs) } : {}),
        ...(ms.summary ? { summary: ms.summary } : {}),
        auditIds: Array.from(ms.auditIds),
        artifactIds: Array.from(ms.artifactIds),
      }),
    );

    const auditGates: TeamworkAuditGateDto[] = Array.from(state.auditGates.values()).map((a) => ({
      auditId: a.auditId,
      ...(a.milestoneId ? { milestoneId: a.milestoneId } : {}),
      label: a.label,
      verdict: a.verdict,
      ...(a.auditorAgentId ? { auditorAgentId: a.auditorAgentId } : {}),
      ...(a.artifactId ? { artifactId: a.artifactId } : {}),
      ...(a.summary ? { summary: a.summary } : {}),
      evidence: toPublicEvidenceDto(a.evidence, nowMs),
      updatedAt: a.updatedAt,
    }));

    const artifacts: TeamworkArtifactRefDto[] = Array.from(state.artifacts.values()).map((art) => ({
      artifactId: art.artifactId,
      title: art.title,
      category: art.category,
      artifactKind: art.artifactKind,
      ...(art.milestoneId ? { milestoneId: art.milestoneId } : {}),
      ...(art.ownerAgentId ? { ownerAgentId: art.ownerAgentId } : {}),
      ...(art.activityId ? { activityId: art.activityId } : {}),
      revision: art.revision,
      updatedAt: art.updatedAt,
      evidence: toPublicEvidenceDto(art.evidence, nowMs),
    }));

    const dto = TeamworkWorkbenchProjectionDtoSchema.parse({
      contractRevision: TEAMWORK_OBSERVER_CONTRACT_REVISION,
      capabilityId: TEAMWORK_CAPABILITY_ID,
      workflowId: state.workflowId,
      originActivityId: state.originActivityId,
      ...(state.scopingActivityId ? { scopingActivityId: state.scopingActivityId } : {}),
      revision: state.revision,
      readOnly,
      ...(readOnlyReasonCode ? { readOnlyReasonCode } : {}),
      commandDiscovery: state.commandDiscovery,
      phase: state.phase,
      workflowState: sanitizeObservedForPublic(state.workflowState, nowMs),
      approvalGate: state.approvalGate,
      scopingQuestions,
      promptArtifact,
      projectScope,
      confirmedRoles: Array.from(state.confirmedRoles.values()).map(mapRole),
      unconfirmedRoleCandidates: Array.from(state.unconfirmedRoles.values()).map(mapRole),
      ...(milestones.length > 0 ? { milestones } : {}),
      auditGates,
      artifacts,
      eventTraceCount: state.eventTrace.length,
      officialAppGuide: OFFICIAL_TEAMWORK_APP_GUIDE,
    });

    if (containsRawHostPath(dto)) {
      throw new Error('Teamwork public projection invariant violated: raw host path detected');
    }
    return dto;
  }

  getEventTrace(binding: RuntimeBinding, nowMs = this.now()): TeamworkEventTraceEntryDto[] {
    const state = this.getStateForBinding(binding);
    if (!state) return [];
    return state.eventTrace.map((entry) => ({
      seq: entry.seq,
      eventKind: entry.eventKind,
      summary: entry.summary,
      ...(entry.entityId ? { entityId: entry.entityId } : {}),
      ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
      evidence: toPublicEvidenceDto(entry.evidence, nowMs),
    }));
  }

  /**
   * Implements `NativeWorkflowResourceReaderPort` for `/api/v1/sessions/:id/native/workflows/:workflowId/:resource`.
   * Serves strictly allowlisted `phases`, `logs`, and `artifacts`; marks `board` unavailable for Teamwork.
   */
  createResourceReader(): NativeWorkflowResourceReaderPort {
    return {
      readWorkflowResource: ({ binding, workflowId, resource, pageToken, limit }) => {
        const slotKey = this.slotByWorkflowId.get(workflowId);
        const state = slotKey ? this.statesBySlot.get(slotKey) : this.getStateForBinding(binding);
        if (
          !state ||
          state.workflowId !== workflowId ||
          state.binding.runtimeId !== binding.runtimeId
        ) {
          return {
            revision: 0,
            available: false,
            sourceUnavailableReason: 'teamwork_workflow_not_found',
            items: [],
            nextPageToken: null,
            hasMore: false,
          };
        }

        const nowMs = this.now();
        const offset = parsePageToken(pageToken);
        const pageSize = Math.max(1, Math.min(limit, 200));

        const paginate = (
          allItems: NativeWorkflowResourceItemDto[],
          emptyUnavailableReason?: string,
        ) => {
          if (allItems.length === 0 && emptyUnavailableReason) {
            return {
              revision: state.revision,
              available: false,
              sourceUnavailableReason: emptyUnavailableReason,
              items: [],
              nextPageToken: null,
              hasMore: false,
            };
          }
          const slice = allItems.slice(offset, offset + pageSize);
          const nextOffset = offset + slice.length;
          const hasMore = nextOffset < allItems.length;
          return {
            revision: state.revision,
            available: true,
            items: slice,
            nextPageToken: hasMore ? String(nextOffset) : null,
            hasMore,
          };
        };

        const kind: NativeWorkflowResourceKind = resource;
        switch (kind) {
          case 'board':
            return {
              revision: state.revision,
              available: false,
              sourceUnavailableReason: 'teamwork_board_not_applicable',
              items: [],
              nextPageToken: null,
              hasMore: false,
            };
          case 'phases': {
            const items: NativeWorkflowResourceItemDto[] = Array.from(
              state.milestones.values(),
            ).map((ms) => ({
              kind: 'phase',
              stage: {
                id: ms.id,
                label: ms.label,
                state: sanitizeObservedForPublic(ms.state, nowMs),
                ...(ms.after && ms.after.length > 0 ? { after: [...ms.after] } : {}),
                ...(ms.agentIds.size > 0 ? { agentIds: Array.from(ms.agentIds) } : {}),
              },
              ...(ms.summary ? { summary: ms.summary } : {}),
            }));
            return paginate(items, 'teamwork_milestones_not_observed');
          }
          case 'logs': {
            const items: NativeWorkflowResourceItemDto[] = state.eventTrace.map((entry) => ({
              kind: 'log_entry',
              entryId: `tw_log_${entry.seq}`,
              seq: entry.seq,
              level:
                entry.eventKind === 'approval_forgery_blocked' ||
                entry.eventKind === 'launch_blocked'
                  ? 'error'
                  : entry.eventKind === 'transport_disconnected' ||
                      entry.eventKind === 'generation_fenced'
                    ? 'warn'
                    : 'info',
              summary: `[${entry.eventKind}] ${entry.summary}`,
              truncated: false,
              createdAt: entry.evidence.observedAt,
              evidence: toPublicEvidenceDto(entry.evidence, nowMs),
            }));
            return paginate(items);
          }
          case 'artifacts': {
            const items: NativeWorkflowResourceItemDto[] = Array.from(
              state.artifacts.values(),
            ).map((art) => ({
              kind: 'artifact_ref',
              artifactId: art.artifactId,
              title: art.title,
              artifactKind: art.artifactKind,
              ...(art.ownerAgentId ? { ownerAgentId: art.ownerAgentId } : {}),
              ...(art.activityId ? { activityId: art.activityId } : {}),
              revision: art.revision,
              updatedAt: art.updatedAt,
              evidence: toPublicEvidenceDto(art.evidence, nowMs),
            }));
            return paginate(items, 'teamwork_artifacts_not_observed');
          }
        }
      },
    };
  }
}
