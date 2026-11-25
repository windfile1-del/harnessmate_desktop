import type { RpcId, WorkOutcome, WorkState } from '@harnessmate/protocol';
import type { NativeIngress } from '../../wiring/types.js';
import type { CodecRuleDescriptor } from '../../runtime/types.js';
import type {
  DecodedDynamicStepPatch,
  DecodedDynamicWorkflowFrame,
  DynamicStepExecutionMode,
} from './types.js';

export const DYNAMIC_WORKFLOW_CODEC_RULES: readonly CodecRuleDescriptor[] = Object.freeze([
  {
    id: 'np11-dynamic-workflow-trigger',
    version: '1.0.0',
    minCliVersion: '1.5.15',
    traceRefs: ['E01', 'E05', 'T13-synthetic'],
    description:
      'Recognizes run_workflow / dynamic_workflow tool calls and structured workflow metadata without parsing Python source to synthesize phases.',
  },
  {
    id: 'np11-dynamic-step-and-dag-explicit-only',
    version: '1.0.0',
    minCliVersion: '1.5.15',
    traceRefs: ['08_Shared_Contracts.md#NativeStage', 'T13-synthetic'],
    description:
      'Populates NativeStage `after` edges ONLY when explicit dependency fields (`after`, `dependsOn`, `upstreamStepIds`) are present on wire payloads.',
  },
  {
    id: 'np11-dynamic-structured-output-and-outcome',
    version: '1.0.0',
    minCliVersion: '1.5.15',
    traceRefs: ['08_Shared_Contracts.md#L105', 'T13-synthetic'],
    description:
      'Parses bounded JSON structured outputs safely (no eval/Python execution) and separates `finished` from `outcome=succeeded` unless explicitly confirmed.',
  },
  {
    id: 'np11-dynamic-1516-forwarded-request',
    version: '1.0.0',
    minCliVersion: '1.5.16',
    traceRefs: ['CLI-1.5.16', 'E05#turn_ask_question', 'T13-synthetic'],
    description:
      'Detects workflow script approval and AGY 1.5.16 forwarded interaction_* question requests while preserving numeric vs string RpcId and outer sessionId.',
  },
]);

const KNOWN_DYNAMIC_UPDATE_KEYS = new Set([
  'sessionUpdate',
  'type',
  'toolCallId',
  'title',
  'kind',
  'toolName',
  'status',
  'rawInput',
  'rawOutput',
  'content',
  'locations',
  'sessionId',
  'childSessionId',
  'workflowId',
  'workflowKind',
  'stepId',
  'stageId',
  'steps',
  'phases',
  '_meta',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRpcId(value: unknown): value is RpcId {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isInteger(value))
  );
}

function mapWireStatusToStateAndOutcome(
  rawStatusValue: unknown,
  rawOutput: Record<string, unknown> | null,
): {
  state?: WorkState;
  stateReasonCode?: string;
  outcome?: WorkOutcome;
  outcomeReasonCode?: string;
} {
  const exitCode =
    rawOutput && typeof rawOutput.exitCode === 'number' && Number.isInteger(rawOutput.exitCode)
      ? rawOutput.exitCode
      : undefined;
  const isError =
    rawOutput?.isError === true ||
    rawOutput?.ok === false ||
    typeof rawOutput?.error === 'string' ||
    isRecord(rawOutput?.error);
  const isExplicitOk = rawOutput?.ok === true || rawOutput?.status === 'ok';

  if (rawStatusValue === undefined) {
    if (exitCode !== undefined && exitCode !== 0) {
      return { state: 'failed', outcome: 'failed' };
    }
    if (isError) {
      return { state: 'failed', outcome: 'failed' };
    }
    return {};
  }

  if (rawStatusValue === null) {
    return { state: 'unknown', stateReasonCode: 'wire_status_null' };
  }

  const normalized = typeof rawStatusValue === 'string' ? rawStatusValue.trim().toLowerCase() : '';
  switch (normalized) {
    case 'pending':
    case 'queued':
      return { state: 'queued' };
    case 'in_progress':
    case 'running':
      return { state: 'running' };
    case 'waiting':
      return { state: 'waiting' };
    case 'requires_action':
    case 'awaiting_approval':
      return { state: 'requires_action' };
    case 'failed':
    case 'error':
      return { state: 'failed', outcome: 'failed' };
    case 'cancelled':
    case 'canceled':
    case 'denied':
    case 'rejected':
      return { state: 'cancelled', outcome: 'cancelled' };
    case 'completed':
    case 'done':
    case 'finished':
      if ((exitCode !== undefined && exitCode !== 0) || isError) {
        return { state: 'failed', outcome: 'failed' };
      }
      if (exitCode === 0 || isExplicitOk) {
        return { state: 'finished', outcome: 'succeeded' };
      }
      return {
        state: 'finished',
        outcomeReasonCode: 'outcome_not_reported_by_wire',
      };
    default:
      return {
        state: 'unknown',
        stateReasonCode: normalized
          ? `unrecognized_wire_status:${normalized.slice(0, 48)}`
          : 'empty_wire_status',
      };
  }
}

function extractMetaHints(
  params: Record<string, unknown>,
  updateOrToolCall: Record<string, unknown>,
): {
  workflowId?: string;
  workflowKind?: string;
  stepId?: string;
  childSessionHint?: string;
  isScriptApproval?: boolean;
} {
  const paramMeta = isRecord(params._meta) ? params._meta : {};
  const itemMeta = isRecord(updateOrToolCall._meta) ? updateOrToolCall._meta : {};
  const agyParamMeta = isRecord(paramMeta.antigravity) ? paramMeta.antigravity : {};
  const agyItemMeta = isRecord(itemMeta.antigravity) ? itemMeta.antigravity : {};

  const workflowId =
    asNonEmptyString(updateOrToolCall.workflowId) ??
    asNonEmptyString(params.workflowId) ??
    asNonEmptyString(itemMeta.workflowId) ??
    asNonEmptyString(paramMeta.workflowId) ??
    asNonEmptyString(agyItemMeta.workflowId) ??
    asNonEmptyString(agyParamMeta.workflowId);

  const workflowKind =
    asNonEmptyString(updateOrToolCall.workflowKind) ??
    asNonEmptyString(params.workflowKind) ??
    asNonEmptyString(itemMeta.workflowKind) ??
    asNonEmptyString(paramMeta.workflowKind) ??
    asNonEmptyString(agyItemMeta.workflowKind) ??
    asNonEmptyString(agyParamMeta.workflowKind);

  const stepId =
    asNonEmptyString(updateOrToolCall.stepId) ??
    asNonEmptyString(updateOrToolCall.stageId) ??
    asNonEmptyString(params.stepId) ??
    asNonEmptyString(itemMeta.stepId) ??
    asNonEmptyString(itemMeta.stageId) ??
    asNonEmptyString(agyItemMeta.stepId) ??
    asNonEmptyString(agyParamMeta.stepId);

  const childSessionHint =
    asNonEmptyString(params.childSessionId) ??
    asNonEmptyString(params.subagentSessionId) ??
    asNonEmptyString(updateOrToolCall.childSessionId) ??
    asNonEmptyString(itemMeta.childSessionId) ??
    asNonEmptyString(paramMeta.childSessionId) ??
    asNonEmptyString(agyItemMeta.childConversationId) ??
    asNonEmptyString(agyParamMeta.childConversationId);

  const isScriptApproval =
    itemMeta.dynamicWorkflowScriptApproval === true ||
    paramMeta.dynamicWorkflowScriptApproval === true ||
    agyItemMeta.scriptApproval === true ||
    agyParamMeta.scriptApproval === true;

  return {
    ...(workflowId ? { workflowId } : {}),
    ...(workflowKind ? { workflowKind } : {}),
    ...(stepId ? { stepId } : {}),
    ...(childSessionHint ? { childSessionHint } : {}),
    ...(isScriptApproval ? { isScriptApproval } : {}),
  };
}

function isDynamicWorkflowSignature(params: {
  readonly title?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly workflowKind?: string;
  readonly rawInput: Record<string, unknown> | null;
  readonly rawOutput: Record<string, unknown> | null;
  readonly update: Record<string, unknown>;
}): boolean {
  if (params.workflowKind?.toLowerCase() === 'dynamic') return true;
  if (params.toolName && /^(run_workflow|dynamic_workflow|\/?run-workflow)$/i.test(params.toolName)) {
    return true;
  }
  if (params.title && /\b(run_workflow|dynamic[_ -]workflow|\/run-workflow)\b/i.test(params.title)) {
    return true;
  }
  if (params.toolCallId && /^(dynwf_|workflow_dyn_|run_workflow_)/i.test(params.toolCallId)) {
    return true;
  }
  if (
    params.rawInput &&
    (params.rawInput.workflowKind === 'dynamic' ||
      typeof params.rawInput.Script === 'string' ||
      typeof params.rawInput.ScriptPath === 'string' ||
      typeof params.rawInput.workflowId === 'string')
  ) {
    return true;
  }
  if (
    params.rawOutput &&
    (params.rawOutput.workflowKind === 'dynamic' ||
      Array.isArray(params.rawOutput.steps) ||
      Array.isArray(params.rawOutput.phases))
  ) {
    return true;
  }
  if (Array.isArray(params.update.steps) || Array.isArray(params.update.phases)) {
    return true;
  }
  return false;
}

function parseExplicitDependencyEdges(rawStep: Record<string, unknown>): readonly string[] | undefined {
  const rawDeps = rawStep.after ?? rawStep.dependsOn ?? rawStep.upstreamStepIds;
  if (!Array.isArray(rawDeps)) return undefined;
  const cleaned = rawDeps
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 128));
  return cleaned;
}

function parseExecutionMode(rawStep: Record<string, unknown>): DynamicStepExecutionMode {
  const rawMode = asNonEmptyString(rawStep.executionMode ?? rawStep.mode)?.toLowerCase();
  if (rawMode === 'parallel' || rawStep.parallel === true) return 'parallel';
  if (rawMode === 'serial' || rawMode === 'sequential' || rawStep.parallel === false) {
    return 'serial';
  }
  return 'unknown';
}

function tryExtractStructuredPayload(rawOutput: Record<string, unknown> | null): unknown {
  if (!rawOutput) return undefined;
  if ('structuredOutput' in rawOutput && rawOutput.structuredOutput !== undefined) {
    return rawOutput.structuredOutput;
  }
  if ('result' in rawOutput && rawOutput.result !== undefined) {
    return rawOutput.result;
  }
  const textCandidate = asNonEmptyString(rawOutput.stdout) ?? asNonEmptyString(rawOutput.output);
  if (textCandidate && textCandidate.length <= 65_536) {
    const trimmed = textCandidate.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function extractErrorSummary(rawOutput: Record<string, unknown> | null): string | undefined {
  if (!rawOutput) return undefined;
  if (typeof rawOutput.error === 'string' && rawOutput.error.trim()) {
    return rawOutput.error.trim().slice(0, 500);
  }
  if (isRecord(rawOutput.error) && typeof rawOutput.error.message === 'string') {
    return rawOutput.error.message.trim().slice(0, 500);
  }
  if (typeof rawOutput.stderr === 'string' && rawOutput.stderr.trim()) {
    return rawOutput.stderr.trim().slice(0, 500);
  }
  if (typeof rawOutput.exitCode === 'number' && rawOutput.exitCode !== 0) {
    return `Step exited with code ${rawOutput.exitCode}`;
  }
  return undefined;
}

function extractBoundedLog(rawOutput: Record<string, unknown> | null): {
  logText?: string;
  logLevel: 'info' | 'warn' | 'error';
  logTruncated: boolean;
} {
  if (!rawOutput) return { logLevel: 'info', logTruncated: false };
  const stderr = asNonEmptyString(rawOutput.stderr);
  const stdout = asNonEmptyString(rawOutput.stdout) ?? asNonEmptyString(rawOutput.log) ?? asNonEmptyString(rawOutput.message);
  const rawText = stderr ?? stdout;
  if (!rawText) return { logLevel: 'info', logTruncated: false };

  const MAX_LOG_CHARS = 3800;
  const truncated = rawText.length > MAX_LOG_CHARS;
  const logText = truncated ? rawText.slice(0, MAX_LOG_CHARS) : rawText;
  const logLevel: 'info' | 'warn' | 'error' =
    stderr || rawOutput.isError === true || rawOutput.ok === false
      ? 'error'
      : rawOutput.level === 'warn'
        ? 'warn'
        : 'info';

  return { logText, logLevel, logTruncated: truncated };
}

function parseStepList(
  rawSteps: unknown,
  rawOutput: Record<string, unknown> | null,
): DecodedDynamicStepPatch[] {
  if (!Array.isArray(rawSteps)) return [];
  const parsed: DecodedDynamicStepPatch[] = [];
  for (const item of rawSteps) {
    if (!isRecord(item)) continue;
    const id = asNonEmptyString(item.id ?? item.stepId ?? item.stageId);
    if (!id) continue;
    const stepRawOut = isRecord(item.rawOutput) ? item.rawOutput : null;
    const effectiveOut = stepRawOut ?? (item.error !== undefined || item.exitCode !== undefined ? item : null);
    const statusMapped = mapWireStatusToStateAndOutcome(item.status ?? item.state, effectiveOut);
    const after = parseExplicitDependencyEdges(item);
    const structuredPayload =
      item.structuredOutput !== undefined
        ? item.structuredOutput
        : item.result !== undefined
          ? item.result
          : stepRawOut
            ? tryExtractStructuredPayload(stepRawOut)
            : undefined;
    const errorSummary =
      asNonEmptyString(item.errorSummary) ??
      extractErrorSummary(effectiveOut) ??
      (statusMapped.state === 'failed' ? extractErrorSummary(rawOutput) : undefined);
    const logInfo = extractBoundedLog(stepRawOut ?? (typeof item.log === 'string' ? { log: item.log } : null));
    const label = asNonEmptyString(item.label ?? item.title ?? item.name);
    const resultArtifactId = asNonEmptyString(item.resultArtifactId ?? item.artifactId);

    parsed.push({
      id: id.slice(0, 128),
      ...(label ? { label: label.slice(0, 200) } : {}),
      ...(statusMapped.state ? { state: statusMapped.state } : {}),
      ...(statusMapped.stateReasonCode ? { stateReasonCode: statusMapped.stateReasonCode } : {}),
      ...(statusMapped.outcome ? { outcome: statusMapped.outcome } : {}),
      ...(statusMapped.outcomeReasonCode
        ? { outcomeReasonCode: statusMapped.outcomeReasonCode }
        : {}),
      ...(after !== undefined ? { after } : {}),
      executionMode: parseExecutionMode(item),
      ...(errorSummary ? { errorSummary } : {}),
      ...(resultArtifactId ? { resultArtifactId } : {}),
      ...(structuredPayload !== undefined ? { structuredPayload } : {}),
      ...(logInfo.logText ? { logText: logInfo.logText, logLevel: logInfo.logLevel, logTruncated: logInfo.logTruncated } : {}),
    });
  }
  return parsed;
}

/**
 * Decodes an incoming AGY ACP frame into a strictly typed NP-11 Dynamic Workflow frame.
 * Never executes Python, never reads host `ScriptPath`, and never invents `after` DAG edges.
 */
export function decodeDynamicWorkflowIngress(
  envelope: NativeIngress,
  opts?: { readonly strictMode?: boolean },
): DecodedDynamicWorkflowFrame {
  const wire = envelope.wire;
  if (!isRecord(wire)) {
    return { kind: 'not_dynamic_workflow', reasonCode: 'wire_not_object' };
  }

  const method = asNonEmptyString(wire.method);
  const params = isRecord(wire.params) ? wire.params : null;
  if (!method || !params) {
    return { kind: 'not_dynamic_workflow', reasonCode: 'missing_method_or_params' };
  }

  // Server-initiated permission / AGY 1.5.16 interaction_* question request
  if ('id' in wire && isRpcId(wire.id)) {
    if (method !== 'session/request_permission' && method !== 'elicitation/create' && method !== 'session/elicitation/create') {
      return { kind: 'not_dynamic_workflow', reasonCode: 'unhandled_request_method' };
    }
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : null;
    const toolCallId = asNonEmptyString(toolCall.toolCallId);
    const title = asNonEmptyString(toolCall.title) ?? asNonEmptyString(params.title);
    const hints = extractMetaHints(params, toolCall);

    const isDynamicReq =
      Boolean(hints.workflowKind?.toLowerCase() === 'dynamic') ||
      Boolean(hints.workflowId) ||
      Boolean(hints.isScriptApproval) ||
      Boolean(toolCallId && /^(dynwf_|workflow_dyn_|run_workflow_)/i.test(toolCallId)) ||
      Boolean(title && /\b(run_workflow|dynamic[_ -]workflow|\/run-workflow)\b/i.test(title)) ||
      Boolean(rawInput && (typeof rawInput.Script === 'string' || typeof rawInput.ScriptPath === 'string' || rawInput.workflowKind === 'dynamic'));

    if (!isDynamicReq) {
      return { kind: 'not_dynamic_workflow', reasonCode: 'request_not_dynamic_workflow' };
    }

    const actualNativeSessionId =
      asNonEmptyString(params.sessionId) ?? envelope.originSession ?? 'unknown_session';
    const isInteractionQuestion =
      Boolean(toolCallId?.startsWith('interaction_')) ||
      asNonEmptyString(toolCall.kind)?.toLowerCase() === 'question';
    const scriptText =
      rawInput && typeof rawInput.Script === 'string' && rawInput.Script.trim().length > 0
        ? rawInput.Script
        : undefined;
    const scriptPathRedacted = Boolean(
      rawInput && typeof rawInput.ScriptPath === 'string' && rawInput.ScriptPath.trim().length > 0,
    );
    const optionIds = Array.isArray(params.options)
      ? params.options
          .map((o) => (isRecord(o) ? asNonEmptyString(o.optionId) : undefined))
          .filter((id): id is string => Boolean(id))
      : [];

    const summary =
      (rawInput && asNonEmptyString(rawInput.question)) ??
      asNonEmptyString(params.description) ??
      title ??
      asNonEmptyString(params.message) ??
      'Dynamic workflow approval requested';

    return {
      kind: 'dynamic_workflow_request',
      wireRequestId: wire.id,
      rpcIdType: typeof wire.id === 'number' ? 'number' : 'string',
      method,
      actualNativeSessionId,
      ...(toolCallId ? { toolCallId } : {}),
      ...(hints.workflowId ? { workflowNativeId: hints.workflowId } : {}),
      ...(hints.stepId ? { stepId: hints.stepId } : {}),
      ...(hints.childSessionHint ? { childSessionHint: hints.childSessionHint } : {}),
      isScriptApproval:
        Boolean(hints.isScriptApproval) ||
        Boolean(scriptText) ||
        scriptPathRedacted ||
        /\bscript\b/i.test(summary),
      isInteractionQuestion,
      summary,
      ...(scriptText ? { scriptText } : {}),
      scriptPathRedacted,
      optionIds,
    };
  }

  if (method !== 'session/update') {
    return { kind: 'not_dynamic_workflow', reasonCode: 'not_session_update' };
  }

  const update = isRecord(params.update) ? params.update : params;
  const sessionUpdate = asNonEmptyString(update.sessionUpdate ?? update.type);
  if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') {
    return { kind: 'not_dynamic_workflow', reasonCode: 'not_tool_update' };
  }

  const toolCallId = asNonEmptyString(update.toolCallId);
  if (!toolCallId) {
    return { kind: 'not_dynamic_workflow', reasonCode: 'missing_tool_call_id' };
  }

  const rawInput = isRecord(update.rawInput) ? update.rawInput : null;
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : null;
  const title = asNonEmptyString(update.title);
  const toolName = asNonEmptyString(update.toolName);
  const hints = extractMetaHints(params, update);

  if (
    opts?.strictMode &&
    hints.workflowKind?.toLowerCase() !== 'dynamic' &&
    !hints.workflowId
  ) {
    return { kind: 'not_dynamic_workflow', reasonCode: 'strict_mode_unmarked_workflow' };
  }

  const isDynamic =
    Boolean(hints.workflowId) ||
    isDynamicWorkflowSignature({
      title,
      toolName,
      toolCallId,
      workflowKind: hints.workflowKind,
      rawInput,
      rawOutput,
      update,
    });

  if (!isDynamic) {
    return { kind: 'not_dynamic_workflow', reasonCode: 'not_dynamic_workflow_tool' };
  }

  const workflowNativeId =
    hints.workflowId ??
    (rawInput ? asNonEmptyString(rawInput.workflowId) : undefined) ??
    (rawOutput ? asNonEmptyString(rawOutput.workflowId) : undefined) ??
    toolCallId;

  const objective =
    (rawInput ? asNonEmptyString(rawInput.Task ?? rawInput.task ?? rawInput.objective ?? rawInput.Prompt) : undefined) ??
    title;

  const scriptText =
    rawInput && typeof rawInput.Script === 'string' && rawInput.Script.trim().length > 0
      ? rawInput.Script
      : undefined;
  const scriptPathRedacted = Boolean(
    rawInput && typeof rawInput.ScriptPath === 'string' && rawInput.ScriptPath.trim().length > 0,
  );

  const statusMapped = mapWireStatusToStateAndOutcome(update.status, rawOutput);

  const rawStepList = update.steps ?? update.phases ?? rawOutput?.steps ?? rawOutput?.phases;
  let steps = parseStepList(rawStepList, rawOutput);

  // Also support single step-level tool_call_update linked via `stepId` / `stageId`
  const stepId =
    hints.stepId ??
    (rawInput ? asNonEmptyString(rawInput.stepId ?? rawInput.stageId) : undefined) ??
    (rawOutput ? asNonEmptyString(rawOutput.stepId ?? rawOutput.stageId) : undefined);

  if (steps.length === 0 && stepId) {
    const after =
      (rawInput ? parseExplicitDependencyEdges(rawInput) : undefined) ??
      (rawOutput ? parseExplicitDependencyEdges(rawOutput) : undefined);
    const structuredPayload = tryExtractStructuredPayload(rawOutput);
    const errorSummary = extractErrorSummary(rawOutput);
    const logInfo = extractBoundedLog(rawOutput);
    const resultArtifactId = rawOutput
      ? asNonEmptyString(rawOutput.resultArtifactId ?? rawOutput.artifactId)
      : undefined;

    steps = [
      {
        id: stepId.slice(0, 128),
        ...(title ? { label: title.slice(0, 200) } : {}),
        ...(statusMapped.state ? { state: statusMapped.state } : {}),
        ...(statusMapped.stateReasonCode ? { stateReasonCode: statusMapped.stateReasonCode } : {}),
        ...(statusMapped.outcome ? { outcome: statusMapped.outcome } : {}),
        ...(statusMapped.outcomeReasonCode
          ? { outcomeReasonCode: statusMapped.outcomeReasonCode }
          : {}),
        ...(after !== undefined ? { after } : {}),
        executionMode: rawInput ? parseExecutionMode(rawInput) : 'unknown',
        ...(errorSummary ? { errorSummary } : {}),
        ...(resultArtifactId ? { resultArtifactId } : {}),
        ...(structuredPayload !== undefined ? { structuredPayload } : {}),
        ...(logInfo.logText
          ? {
              logText: logInfo.logText,
              logLevel: logInfo.logLevel,
              logTruncated: logInfo.logTruncated,
            }
          : {}),
      },
    ];
  }

  const structuredOutputPayload = !stepId ? tryExtractStructuredPayload(rawOutput) : undefined;
  const resultArtifactId = !stepId && rawOutput
    ? asNonEmptyString(rawOutput.resultArtifactId ?? rawOutput.artifactId)
    : undefined;
  const logInfo = extractBoundedLog(rawOutput);

  const isDetached =
    rawInput?.IsDaemon === true ||
    rawInput?.isDaemon === true ||
    rawInput?.detached === true;
  const isBlocking =
    rawInput?.isBackground === true ||
    typeof rawInput?.backgroundTaskId === 'string' ||
    steps.length > 0 ||
    !isDetached;

  const blocking = isDetached
    ? 'detached'
    : isBlocking
      ? 'confirmed_blocking'
      : 'unknown';

  const unknownFields = Object.keys(update).filter((k) => !KNOWN_DYNAMIC_UPDATE_KEYS.has(k));
  const matchedRuleIds = ['np11-dynamic-workflow-trigger'];
  if (steps.length > 0) matchedRuleIds.push('np11-dynamic-step-and-dag-explicit-only');
  if (structuredOutputPayload !== undefined || statusMapped.outcome || statusMapped.outcomeReasonCode) {
    matchedRuleIds.push('np11-dynamic-structured-output-and-outcome');
  }

  // If this update is purely for an inner step, do not overwrite root workflow state as failed/finished
  // unless the update explicitly addresses the workflow root itself.
  const isRootWorkflowUpdate = !stepId || workflowNativeId === toolCallId;

  return {
    kind: 'dynamic_tool_patch',
    updateKind: sessionUpdate,
    toolCallId,
    workflowNativeId,
    ...(title ? { title } : {}),
    ...(objective ? { objective } : {}),
    ...(scriptText ? { scriptText } : {}),
    scriptPathRedacted,
    ...(stepId ? { stepId } : {}),
    ...(isRootWorkflowUpdate && statusMapped.state ? { workflowState: statusMapped.state } : {}),
    ...(isRootWorkflowUpdate && statusMapped.stateReasonCode
      ? { workflowStateReasonCode: statusMapped.stateReasonCode }
      : {}),
    ...(isRootWorkflowUpdate && statusMapped.outcome
      ? { workflowOutcome: statusMapped.outcome }
      : {}),
    ...(isRootWorkflowUpdate && statusMapped.outcomeReasonCode
      ? { workflowOutcomeReasonCode: statusMapped.outcomeReasonCode }
      : {}),
    blocking,
    steps,
    ...(structuredOutputPayload !== undefined ? { structuredOutputPayload } : {}),
    ...(resultArtifactId ? { resultArtifactId } : {}),
    ...(logInfo.logText ? { logText: logInfo.logText } : {}),
    logLevel: logInfo.logLevel,
    logTruncated: logInfo.logTruncated,
    ...(hints.childSessionHint ? { childSessionHint: hints.childSessionHint } : {}),
    unknownFields,
    matchedRuleIds,
  };
}
