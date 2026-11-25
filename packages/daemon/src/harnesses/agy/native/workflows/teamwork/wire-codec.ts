import type {
  Evidence,
  NativeAgentId,
  WorkOutcome,
  WorkState,
} from '@harnessmate/protocol';
import type { NativeIngress } from '../../wiring/types.js';
import {
  TEAMWORK_LEGACY_PREVIEW_SLASH_COMMANDS,
  TEAMWORK_PRIMARY_SLASH_COMMAND,
  type TeamworkArtifactCategory,
  type TeamworkRoleKind,
} from './schemas.js';

export interface TeamworkCodecRuleDescriptor {
  readonly id: string;
  readonly version: string;
  readonly evidenceStatus: 'acp_v1_standard' | 'synthetic_candidate_pending_live_capture';
  readonly traceRefs: readonly string[];
  readonly description: string;
}

export const TEAMWORK_CODEC_RULES: readonly TeamworkCodecRuleDescriptor[] = Object.freeze([
  {
    id: 'teamwork-command-advertisement',
    version: '1.0.0',
    evidenceStatus: 'acp_v1_standard',
    traceRefs: ['E02', 'E05', '03_Official_Research.md#L32'],
    description:
      'Detects /teamwork in available_commands_update and explicitly separates legacy /teamwork-preview without aliasing it to /teamwork.',
  },
  {
    id: 'teamwork-scoping-request',
    version: '1.0.0',
    evidenceStatus: 'synthetic_candidate_pending_live_capture',
    traceRefs: ['E05:interaction_*', 'NP07:wire-codec.ts', 'T12-synthetic'],
    description:
      'Decodes structured Teamwork scoping question signals (interaction_* / elicitation / explicit teamwork metadata) with stable dedup keys.',
  },
  {
    id: 'teamwork-prompt-artifact-gate',
    version: '1.0.0',
    evidenceStatus: 'synthetic_candidate_pending_live_capture',
    traceRefs: ['03_Official_Research.md#L32', 'NP-10-teamwork.md', 'T12-synthetic'],
    description:
      'Decodes explicit structured Prompt Artifact creation and native approval/rejection gate signals; never infers approval from natural language text.',
  },
  {
    id: 'teamwork-project-milestone-audit',
    version: '1.0.0',
    evidenceStatus: 'synthetic_candidate_pending_live_capture',
    traceRefs: ['08_Shared_Contracts.md#L120', 'NP-10-teamwork.md', 'T12-synthetic'],
    description:
      'Decodes explicit structured Teamwork project directory, role attribution (Sentinel / Project Orchestrator / Auditor), milestone, and audit updates.',
  },
]);

export type DecodedTeamworkSignal =
  | {
      readonly kind: 'command_catalog';
      readonly advertisedCommands: readonly string[];
      readonly teamworkAdvertised: boolean;
      readonly legacyPreviewAdvertised: boolean;
    }
  | {
      readonly kind: 'scoping_question';
      readonly dedupKey: string;
      readonly toolCallId?: string;
      readonly promptSummary: string;
      readonly requestKind: 'question' | 'elicitation' | 'permission';
      readonly workflowHintId?: string;
    }
  | {
      readonly kind: 'prompt_artifact';
      readonly artifactId: string;
      readonly title: string;
      readonly revision?: number;
      readonly previewExcerpt?: string;
      readonly requiresApproval: boolean;
      readonly approvalRequestId?: string;
      readonly workflowHintId?: string;
    }
  | {
      readonly kind: 'prompt_gate_decision';
      readonly decision: 'approved' | 'rejected' | 'cancelled' | 'expired';
      readonly artifactId?: string;
      readonly approvalRequestId?: string;
      readonly reasonCode?: string;
      readonly viaNativeProtocol: boolean;
      readonly workflowHintId?: string;
    }
  | {
      readonly kind: 'project_scope';
      readonly projectLabel?: string;
      readonly nativeProjectPath?: string;
      readonly workflowHintId?: string;
    }
  | {
      readonly kind: 'role_event';
      readonly roleKind: TeamworkRoleKind;
      readonly displayLabel: string;
      readonly wireChildSessionId?: string;
      readonly toolCallId?: string;
      readonly agentIdHint?: NativeAgentId;
      readonly milestoneId?: string;
      readonly workflowHintId?: string;
    }
  | {
      readonly kind: 'milestone_update';
      readonly milestoneId: string;
      readonly label: string;
      readonly state: WorkState;
      readonly outcome?: WorkOutcome;
      readonly after?: readonly string[];
      readonly agentIds?: readonly NativeAgentId[];
      readonly summary?: string;
      readonly workflowHintId?: string;
    }
  | {
      readonly kind: 'audit_update';
      readonly auditId: string;
      readonly milestoneId?: string;
      readonly label: string;
      readonly verdict: 'pending' | 'passed' | 'changes_requested' | 'failed' | 'cancelled' | 'unknown';
      readonly auditorAgentId?: NativeAgentId;
      readonly artifactId?: string;
      readonly summary?: string;
      readonly workflowHintId?: string;
    }
  | {
      readonly kind: 'artifact_ref';
      readonly artifactId: string;
      readonly title: string;
      readonly category: TeamworkArtifactCategory;
      readonly artifactKind: 'markdown' | 'text' | 'diff' | 'script' | 'json' | 'media' | 'unknown';
      readonly milestoneId?: string;
      readonly ownerAgentId?: NativeAgentId;
      readonly revision?: number;
      readonly workflowHintId?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, maxLen = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLen) : undefined;
}

function normalizeCommandName(raw: string): string {
  return raw.trim().replace(/^\/+/, '').toLowerCase();
}

export function isLegacyTeamworkPreviewCommand(rawCommand: string): boolean {
  const normalized = normalizeCommandName(rawCommand).split(/\s+/)[0] ?? '';
  return (TEAMWORK_LEGACY_PREVIEW_SLASH_COMMANDS as readonly string[]).includes(normalized);
}

export function isCanonicalTeamworkCommand(rawCommand: string): boolean {
  const normalized = normalizeCommandName(rawCommand).split(/\s+/)[0] ?? '';
  return normalized === TEAMWORK_PRIMARY_SLASH_COMMAND;
}

export function classifyTeamworkRoleKind(rawRole: string | undefined): TeamworkRoleKind {
  if (!rawRole) return 'unknown_role';
  const lowered = rawRole.trim().toLowerCase();
  if (lowered === 'sentinel' || lowered.includes('sentinel')) return 'sentinel';
  if (
    lowered === 'orchestrator' ||
    lowered === 'project_orchestrator' ||
    lowered.includes('project orchestrator') ||
    lowered.includes('orchestrator')
  ) {
    return 'project_orchestrator';
  }
  if (lowered === 'auditor' || lowered === 'audit' || lowered.includes('audit')) {
    return 'auditor';
  }
  if (
    lowered === 'worker' ||
    lowered === 'milestone_worker' ||
    lowered.includes('worker') ||
    lowered.includes('executor') ||
    lowered.includes('implementer')
  ) {
    return 'milestone_worker';
  }
  return 'unknown_role';
}

function parseWorkState(raw: unknown): WorkState {
  if (typeof raw !== 'string') return 'unknown';
  switch (raw.trim().toLowerCase()) {
    case 'queued':
    case 'pending':
      return 'queued';
    case 'running':
    case 'in_progress':
    case 'active':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'requires_action':
    case 'awaiting_approval':
      return 'requires_action';
    case 'finished':
    case 'completed':
    case 'done':
      return 'finished';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'rejected':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function parseOutcome(raw: unknown): WorkOutcome | undefined {
  if (typeof raw !== 'string') return undefined;
  switch (raw.trim().toLowerCase()) {
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
    case 'rejected':
      return 'cancelled';
    default:
      return undefined;
  }
}

function parseAuditVerdict(
  raw: unknown,
): 'pending' | 'passed' | 'changes_requested' | 'failed' | 'cancelled' | 'unknown' {
  if (typeof raw !== 'string') return 'unknown';
  switch (raw.trim().toLowerCase()) {
    case 'pending':
    case 'running':
    case 'in_progress':
      return 'pending';
    case 'passed':
    case 'approved':
    case 'succeeded':
      return 'passed';
    case 'changes_requested':
    case 'revision_required':
      return 'changes_requested';
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

function parseArtifactCategory(raw: unknown): TeamworkArtifactCategory {
  if (typeof raw !== 'string') return 'unknown';
  switch (raw.trim().toLowerCase()) {
    case 'prompt':
    case 'prompt_artifact':
      return 'prompt_artifact';
    case 'plan':
    case 'milestone_plan':
      return 'milestone_plan';
    case 'deliverable':
    case 'milestone_deliverable':
      return 'milestone_deliverable';
    case 'audit':
    case 'audit_report':
      return 'audit_report';
    default:
      return 'unknown';
  }
}

function parseArtifactKind(
  raw: unknown,
): 'markdown' | 'text' | 'diff' | 'script' | 'json' | 'media' | 'unknown' {
  if (typeof raw !== 'string') return 'unknown';
  switch (raw.trim().toLowerCase()) {
    case 'markdown':
    case 'md':
      return 'markdown';
    case 'text':
    case 'txt':
      return 'text';
    case 'diff':
    case 'patch':
      return 'diff';
    case 'script':
      return 'script';
    case 'json':
      return 'json';
    case 'media':
      return 'media';
    default:
      return 'unknown';
  }
}

function sanitizeOpaqueId(raw: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_');
  if (!cleaned) return 'tw_opaque_unknown';
  return /^[a-zA-Z0-9]/.test(cleaned) ? cleaned.slice(0, 120) : `tw_${cleaned.slice(0, 117)}`;
}

export function buildTeamworkEvidence(
  envelope: NativeIngress,
  wireVariant: string,
  observedAt: number,
): Evidence {
  if (envelope.channel === 'history_replay') {
    return {
      kind: 'replay',
      captureId: `replay:${envelope.connectionId}`,
      ordinal: envelope.ingressOrdinal,
      observedAt,
    };
  }
  return {
    kind: 'live_protocol',
    connectionId: envelope.connectionId,
    ingressOrdinal: envelope.ingressOrdinal,
    wireVariant,
    observedAt,
  };
}

/**
 * Decodes structured ACP v1 frames into typed Teamwork signals.
 *
 * Strict honesty rule:
 * - Plain `agent_message_chunk` / `agent_thought_chunk` prose NEVER produces
 *   approvals, project scopes, roles, milestones, or audit gates.
 * - Only explicit structured wire metadata / tool updates / command updates are decoded.
 */
export function decodeTeamworkIngressSignals(envelope: NativeIngress): DecodedTeamworkSignal[] {
  const wire = envelope.wire;
  if (!isRecord(wire)) return [];

  const method = readNonEmptyString(wire.method, 128);
  const params = isRecord(wire.params) ? wire.params : null;
  if (!method || !params) return [];

  // 1. Server-initiated scoping or Prompt Artifact approval request
  if (
    method === 'session/request_permission' ||
    method === 'elicitation/create' ||
    method === 'session/elicitation/create'
  ) {
    const toolCall = isRecord(params.toolCall) ? params.toolCall : null;
    const meta = isRecord(params._meta)
      ? params._meta
      : toolCall && isRecord(toolCall._meta)
        ? toolCall._meta
        : null;
    const teamworkMeta =
      (meta && isRecord(meta.teamwork) ? meta.teamwork : null) ??
      (isRecord(params.teamwork) ? params.teamwork : null) ??
      (toolCall && isRecord(toolCall.rawInput) && isRecord(toolCall.rawInput.teamwork)
        ? toolCall.rawInput.teamwork
        : null);

    if (!teamworkMeta) return [];

    const stage = readNonEmptyString(teamworkMeta.stage, 64)?.toLowerCase();
    const workflowHintId = readNonEmptyString(teamworkMeta.workflowId, 128);
    const toolCallId = toolCall ? readNonEmptyString(toolCall.toolCallId, 128) : undefined;
    const wireReqId =
      typeof wire.id === 'string' || typeof wire.id === 'number' ? String(wire.id) : undefined;

    if (stage === 'scoping' || stage === 'interview') {
      const rawInput = toolCall && isRecord(toolCall.rawInput) ? toolCall.rawInput : null;
      const promptSummary =
        readNonEmptyString(teamworkMeta.question, 600) ??
        readNonEmptyString(rawInput?.question, 600) ??
        readNonEmptyString(params.message, 600) ??
        readNonEmptyString(toolCall?.title, 600) ??
        'Teamwork 需求访谈问题';
      const dedupKey =
        readNonEmptyString(teamworkMeta.questionKey, 160) ??
        toolCallId ??
        (wireReqId ? `rpc:${wireReqId}` : `ord:${envelope.ingressOrdinal}`);

      return [
        {
          kind: 'scoping_question',
          dedupKey,
          ...(toolCallId ? { toolCallId } : {}),
          promptSummary,
          requestKind:
            method === 'session/request_permission'
              ? toolCallId?.startsWith('interaction_')
                ? 'question'
                : 'permission'
              : 'elicitation',
          ...(workflowHintId ? { workflowHintId } : {}),
        },
      ];
    }

    if (stage === 'prompt_artifact_review' || stage === 'prompt_approval') {
      const artifactId = sanitizeOpaqueId(
        readNonEmptyString(teamworkMeta.promptArtifactId, 128) ??
          readNonEmptyString(teamworkMeta.artifactId, 128) ??
          'art_teamwork_prompt',
      );
      const title = readNonEmptyString(teamworkMeta.title, 200) ?? 'Teamwork Prompt Artifact';
      const previewExcerpt = readNonEmptyString(teamworkMeta.previewExcerpt, 1200);
      return [
        {
          kind: 'prompt_artifact',
          artifactId,
          title,
          ...(previewExcerpt ? { previewExcerpt } : {}),
          requiresApproval: true,
          ...(wireReqId ? { approvalRequestId: `rpc:${wireReqId}` } : {}),
          ...(workflowHintId ? { workflowHintId } : {}),
        },
      ];
    }

    return [];
  }

  if (method !== 'session/update') return [];

  const update = isRecord(params.update) ? params.update : params;
  const updateType =
    readNonEmptyString(update.sessionUpdate, 64) ?? readNonEmptyString(update.type, 64) ?? '';

  // 2. Command discovery (`available_commands_update`)
  if (updateType === 'available_commands_update') {
    const rawList = Array.isArray(update.availableCommands) ? update.availableCommands : [];
    const names: string[] = [];
    for (const item of rawList) {
      if (typeof item === 'string') {
        const n = normalizeCommandName(item);
        if (n) names.push(n);
      } else if (isRecord(item)) {
        const n = readNonEmptyString(item.name, 80);
        if (n) names.push(normalizeCommandName(n));
      }
    }
    return [
      {
        kind: 'command_catalog',
        advertisedCommands: names,
        teamworkAdvertised: names.includes(TEAMWORK_PRIMARY_SLASH_COMMAND),
        legacyPreviewAdvertised: names.some((n) =>
          (TEAMWORK_LEGACY_PREVIEW_SLASH_COMMANDS as readonly string[]).includes(n),
        ),
      },
    ];
  }

  // Explicitly NEVER infer Teamwork entities from assistant prose / thoughts
  if (updateType === 'agent_message_chunk' || updateType === 'agent_thought_chunk') {
    return [];
  }

  // 3. Structured `teamwork_update` or `tool_call`/`tool_call_update` carrying explicit `teamwork` structured metadata
  const rawInput = isRecord(update.rawInput) ? update.rawInput : null;
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : null;
  const meta = isRecord(update._meta) ? update._meta : null;

  const teamworkPayload =
    (updateType === 'teamwork_update' ? update : null) ??
    (isRecord(update.teamwork) ? update.teamwork : null) ??
    (meta && isRecord(meta.teamwork) ? meta.teamwork : null) ??
    (rawOutput && isRecord(rawOutput.teamwork) ? rawOutput.teamwork : null) ??
    (rawInput && isRecord(rawInput.teamwork) ? rawInput.teamwork : null);

  if (!teamworkPayload) return [];

  const signals: DecodedTeamworkSignal[] = [];
  const workflowHintId = readNonEmptyString(teamworkPayload.workflowId, 128);
  const toolCallId = readNonEmptyString(update.toolCallId, 128);
  const eventType = readNonEmptyString(teamworkPayload.event ?? teamworkPayload.kind, 64)?.toLowerCase();

  if (eventType === 'scoping_question') {
    const promptSummary =
      readNonEmptyString(teamworkPayload.question, 600) ??
      readNonEmptyString(update.title, 600) ??
      'Teamwork 需求访谈问题';
    const dedupKey =
      readNonEmptyString(teamworkPayload.questionKey, 160) ??
      toolCallId ??
      `ord:${envelope.ingressOrdinal}`;
    signals.push({
      kind: 'scoping_question',
      dedupKey,
      ...(toolCallId ? { toolCallId } : {}),
      promptSummary,
      requestKind: 'question',
      ...(workflowHintId ? { workflowHintId } : {}),
    });
  }

  if (eventType === 'prompt_artifact' || isRecord(teamworkPayload.promptArtifact)) {
    const src = isRecord(teamworkPayload.promptArtifact)
      ? teamworkPayload.promptArtifact
      : teamworkPayload;
    const artifactId = sanitizeOpaqueId(
      readNonEmptyString(src.artifactId, 128) ??
        readNonEmptyString(src.id, 128) ??
        'art_teamwork_prompt',
    );
    const title = readNonEmptyString(src.title, 200) ?? 'Teamwork Prompt Artifact';
    const previewExcerpt = readNonEmptyString(src.previewExcerpt, 1200);
    const revision =
      typeof src.revision === 'number' && Number.isInteger(src.revision) && src.revision >= 0
        ? src.revision
        : undefined;
    const approvalRequestId = readNonEmptyString(src.approvalRequestId, 128);
    signals.push({
      kind: 'prompt_artifact',
      artifactId,
      title,
      ...(revision !== undefined ? { revision } : {}),
      ...(previewExcerpt ? { previewExcerpt } : {}),
      requiresApproval: src.requiresApproval !== false,
      ...(approvalRequestId ? { approvalRequestId } : {}),
      ...(workflowHintId ? { workflowHintId } : {}),
    });
  }

  if (eventType === 'prompt_gate_decision' || isRecord(teamworkPayload.approvalDecision)) {
    const src = isRecord(teamworkPayload.approvalDecision)
      ? teamworkPayload.approvalDecision
      : teamworkPayload;
    const rawDecision = readNonEmptyString(src.decision ?? src.status, 32)?.toLowerCase();
    const decision =
      rawDecision === 'approved'
        ? 'approved'
        : rawDecision === 'rejected' || rawDecision === 'declined'
          ? 'rejected'
          : rawDecision === 'expired'
            ? 'expired'
            : rawDecision === 'cancelled' || rawDecision === 'canceled'
              ? 'cancelled'
              : null;
    if (decision) {
      const artifactId = readNonEmptyString(src.artifactId, 128);
      const approvalRequestId = readNonEmptyString(src.approvalRequestId, 128);
      const reasonCode = readNonEmptyString(src.reasonCode, 128);
      signals.push({
        kind: 'prompt_gate_decision',
        decision,
        ...(artifactId ? { artifactId: sanitizeOpaqueId(artifactId) } : {}),
        ...(approvalRequestId ? { approvalRequestId } : {}),
        ...(reasonCode ? { reasonCode } : {}),
        viaNativeProtocol: src.viaNativeProtocol === true,
        ...(workflowHintId ? { workflowHintId } : {}),
      });
    }
  }

  if (eventType === 'project_created' || eventType === 'project_scope' || isRecord(teamworkPayload.project)) {
    const src = isRecord(teamworkPayload.project) ? teamworkPayload.project : teamworkPayload;
    const projectLabel = readNonEmptyString(src.label ?? src.projectLabel ?? src.name, 160);
    const nativeProjectPath = readNonEmptyString(src.projectPath ?? src.directoryPath, 512);
    if (projectLabel || nativeProjectPath) {
      signals.push({
        kind: 'project_scope',
        ...(projectLabel ? { projectLabel } : {}),
        ...(nativeProjectPath ? { nativeProjectPath } : {}),
        ...(workflowHintId ? { workflowHintId } : {}),
      });
    }
  }

  if (eventType === 'role_assigned' || isRecord(teamworkPayload.role)) {
    const src = isRecord(teamworkPayload.role) ? teamworkPayload.role : teamworkPayload;
    const roleRaw = readNonEmptyString(src.role ?? src.roleKind ?? src.name, 80);
    const displayLabel = readNonEmptyString(src.label ?? src.displayLabel ?? roleRaw, 160) ?? 'Teamwork Role';
    const wireChildSessionId = readNonEmptyString(
      src.childSessionId ?? update.childSessionId ?? params.childSessionId,
      160,
    );
    const milestoneId = readNonEmptyString(src.milestoneId, 128);
    signals.push({
      kind: 'role_event',
      roleKind: classifyTeamworkRoleKind(roleRaw ?? displayLabel),
      displayLabel,
      ...(wireChildSessionId ? { wireChildSessionId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(milestoneId ? { milestoneId } : {}),
      ...(workflowHintId ? { workflowHintId } : {}),
    });
  }

  if (eventType === 'milestone_updated' || isRecord(teamworkPayload.milestone)) {
    const src = isRecord(teamworkPayload.milestone) ? teamworkPayload.milestone : teamworkPayload;
    const milestoneId = readNonEmptyString(src.milestoneId ?? src.id, 128);
    const label = readNonEmptyString(src.label ?? src.title, 200);
    if (milestoneId && label) {
      const after = Array.isArray(src.after)
        ? src.after
            .map((id) => readNonEmptyString(id, 128))
            .filter((id): id is string => Boolean(id))
        : undefined;
      const summary = readNonEmptyString(src.summary, 600);
      const outcome = parseOutcome(src.outcome);
      signals.push({
        kind: 'milestone_update',
        milestoneId,
        label,
        state: parseWorkState(src.state ?? src.status),
        ...(outcome ? { outcome } : {}),
        ...(after && after.length > 0 ? { after } : {}),
        ...(summary ? { summary } : {}),
        ...(workflowHintId ? { workflowHintId } : {}),
      });
    }
  }

  if (eventType === 'audit_updated' || isRecord(teamworkPayload.audit)) {
    const src = isRecord(teamworkPayload.audit) ? teamworkPayload.audit : teamworkPayload;
    const auditId = sanitizeOpaqueId(readNonEmptyString(src.auditId ?? src.id, 128) ?? `aud_${envelope.ingressOrdinal}`);
    const label = readNonEmptyString(src.label ?? src.title, 200) ?? 'Teamwork Audit Gate';
    const milestoneId = readNonEmptyString(src.milestoneId, 128);
    const artifactId = readNonEmptyString(src.artifactId, 128);
    const summary = readNonEmptyString(src.summary, 600);
    signals.push({
      kind: 'audit_update',
      auditId,
      ...(milestoneId ? { milestoneId } : {}),
      label,
      verdict: parseAuditVerdict(src.verdict ?? src.status),
      ...(artifactId ? { artifactId: sanitizeOpaqueId(artifactId) } : {}),
      ...(summary ? { summary } : {}),
      ...(workflowHintId ? { workflowHintId } : {}),
    });
  }

  if (eventType === 'artifact_recorded' || isRecord(teamworkPayload.artifact)) {
    const src = isRecord(teamworkPayload.artifact) ? teamworkPayload.artifact : teamworkPayload;
    const artifactId = readNonEmptyString(src.artifactId ?? src.id, 128);
    const title = readNonEmptyString(src.title, 200);
    if (artifactId && title) {
      const milestoneId = readNonEmptyString(src.milestoneId, 128);
      const revision =
        typeof src.revision === 'number' && Number.isInteger(src.revision) && src.revision >= 0
          ? src.revision
          : undefined;
      signals.push({
        kind: 'artifact_ref',
        artifactId: sanitizeOpaqueId(artifactId),
        title,
        category: parseArtifactCategory(src.category),
        artifactKind: parseArtifactKind(src.artifactKind ?? src.kind),
        ...(milestoneId ? { milestoneId } : {}),
        ...(revision !== undefined ? { revision } : {}),
        ...(workflowHintId ? { workflowHintId } : {}),
      });
    }
  }

  return signals;
}
