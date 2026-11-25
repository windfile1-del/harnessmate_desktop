import type {
  Blocking,
  NativeWorkKind,
  RpcId,
  WorkOutcome,
  WorkState,
} from '@harnessmate/protocol';
import type { NativeIngress } from '../wiring/types.js';
import type {
  CodecRuleDescriptor,
  DecodedToolPatch,
  DecodedWireFrame,
  PatchField,
} from './types.js';

/**
 * Versioned AGY ACP v1 wire codec rules with explicit trace provenance.
 * Every compatibility field mapping references the exact evidence/fixture trace
 * that verified its shape. Unverified fields remain unknown.
 */
export const AGY_REACTIVE_CODEC_RULES: readonly CodecRuleDescriptor[] = Object.freeze([
  {
    id: 'acp-v1-standard-session-update',
    version: '1.0.0',
    traceRefs: ['E02', 'E05:agy-1.5.14/session-full.ndjson', 'ACP-v1'],
    description:
      'Decodes standard ACP v1 session/update frames (tool_call, tool_call_update, agent_message_chunk, agent_thought_chunk, usage_update, session_info_update, available_commands_update, config_option_update, plan).',
  },
  {
    id: 'agy-v1-explicit-background-fields',
    version: '1.0.0',
    minCliVersion: '1.5.10',
    traceRefs: [
      'S06:agy-protocol.ts',
      'E08:0409bc8-synthetic-routing.ndjson',
      'NP01:t02-reactive-20s-wake.ndjson',
      'NP01:t03-long-finite-timeout-exit.ndjson',
      'NP01:t04-parallel-finite-and-daemon.ndjson',
    ],
    description:
      'Classifies explicit structured rawInput background flags: IsDaemon/isDaemon -> daemon+detached; isBackground=true or backgroundTaskId (with IsDaemon!=true) -> finite_command+confirmed_blocking.',
  },
  {
    id: 'agy-v1-schedule-fields',
    version: '1.0.0',
    minCliVersion: '1.5.14',
    traceRefs: ['E05:agy-1.5.14/session-full.ndjson#turn_1_bg', 'S06:agy-protocol.ts'],
    description:
      'Classifies schedule tools via structured CronExpression or DurationSeconds fields as kind=schedule, blocking=detached (never blocks user turn).',
  },
  {
    id: 'agy-v1-subagent-launch-fields',
    version: '1.0.0',
    minCliVersion: '1.5.14',
    traceRefs: ['E05:agy-1.5.14/session-full.ndjson#turn_1_subagent', 'S06:agy-protocol.ts'],
    requiresNonStrictMode: true,
    description:
      'Classifies invoke_subagent tool calls as kind=subagent, blocking=unknown without fabricating confirmed child lineage (deferred to NP-05).',
  },
  {
    id: 'agy-v1-tool-outcome-explicit-only',
    version: '1.0.0',
    traceRefs: [
      '08_Shared_Contracts.md#L105',
      'NP01:t02-reactive-20s-wake.ndjson',
      'NP01:t04-parallel-finite-and-daemon.ndjson',
    ],
    description:
      'Decouples observable work state `finished` from `outcome`: marks `succeeded` ONLY when wire rawOutput explicitly reports exitCode===0 or ok===true; non-zero exitCode marks failed; otherwise outcome remains unknown.',
  },
  {
    id: 'agy-v1-server-request-rpc-fidelity',
    version: '1.0.0',
    traceRefs: [
      'E05:agy-1.5.14/session-full.ndjson#turn_ask_question',
      'NP01:t06-post-turn-permission-and-child.ndjson',
    ],
    description:
      'Preserves numeric vs string JSON-RPC request IDs, detects interaction_* tool calls, and captures optional childSessionId without conflating it with confirmed parent-child lineage.',
  },
]);

const KNOWN_TOOL_UPDATE_KEYS = new Set([
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
  'childSessionId',
  'sessionId',
]);

const KNOWN_MESSAGE_CHUNK_KEYS = new Set([
  'sessionUpdate',
  'type',
  'content',
  'sessionId',
]);

function omit<T>(): PatchField<T> {
  return { op: 'omit' };
}

function clear<T>(): PatchField<T> {
  return { op: 'clear' };
}

function set<T>(value: T): PatchField<T> {
  return { op: 'set', value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isInteger(value))
  );
}

function extractTextFromRawOutput(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === 'string') {
    const trimmed = rawOutput.trim();
    return trimmed ? trimmed.slice(0, 400) : undefined;
  }
  if (isRecord(rawOutput)) {
    if (typeof rawOutput.stdout === 'string' && rawOutput.stdout.trim()) {
      return rawOutput.stdout.trim().slice(0, 400);
    }
    if (typeof rawOutput.stderr === 'string' && rawOutput.stderr.trim()) {
      return rawOutput.stderr.trim().slice(0, 400);
    }
    if (typeof rawOutput.message === 'string' && rawOutput.message.trim()) {
      return rawOutput.message.trim().slice(0, 400);
    }
  }
  return undefined;
}

function extractLabelPatch(
  update: Record<string, unknown>,
  rawInput: Record<string, unknown> | null,
): PatchField<string> {
  if ('title' in update) {
    if (update.title === null) return clear();
    if (typeof update.title === 'string' && update.title.trim()) {
      return set(update.title.trim().slice(0, 240));
    }
  }
  if (rawInput) {
    const candidate =
      (typeof rawInput.CommandLine === 'string' && rawInput.CommandLine.trim()) ||
      (typeof rawInput.command === 'string' && rawInput.command.trim()) ||
      (typeof rawInput.Prompt === 'string' && rawInput.Prompt.trim()) ||
      undefined;
    if (candidate) {
      return set(candidate.slice(0, 240));
    }
  }
  return omit();
}

function decodeToolStatusAndOutcome(
  update: Record<string, unknown>,
): {
  state: PatchField<WorkState>;
  stateReasonCode?: string;
  outcome: PatchField<WorkOutcome>;
  outcomeReasonCode?: string;
  exitCode?: number;
  isNonZeroExit?: boolean;
} {
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : null;
  const exitCode =
    rawOutput && typeof rawOutput.exitCode === 'number' && Number.isInteger(rawOutput.exitCode)
      ? rawOutput.exitCode
      : undefined;
  const isErrorFlag = rawOutput?.isError === true || rawOutput?.ok === false;
  const isExplicitOkFlag = rawOutput?.ok === true || rawOutput?.status === 'ok';

  if (!('status' in update) || update.status === undefined) {
    return {
      state: omit(),
      outcome: omit(),
      exitCode,
      ...(exitCode !== undefined && exitCode !== 0 ? { isNonZeroExit: true } : {}),
    };
  }

  if (update.status === null) {
    return {
      state: set('unknown'),
      stateReasonCode: 'wire_status_null',
      outcome: omit(),
      exitCode,
    };
  }

  const rawStatus = typeof update.status === 'string' ? update.status.trim().toLowerCase() : '';
  switch (rawStatus) {
    case 'pending':
    case 'queued':
      return { state: set('queued'), outcome: omit(), exitCode };
    case 'in_progress':
    case 'running':
      return { state: set('running'), outcome: omit(), exitCode };
    case 'waiting':
      return { state: set('waiting'), outcome: omit(), exitCode };
    case 'requires_action':
    case 'awaiting_approval':
      return { state: set('requires_action'), outcome: omit(), exitCode };
    case 'failed':
    case 'error':
      return {
        state: set('failed'),
        outcome: set('failed'),
        exitCode,
        ...(exitCode !== undefined && exitCode !== 0 ? { isNonZeroExit: true } : {}),
      };
    case 'cancelled':
    case 'canceled':
      return {
        state: set('cancelled'),
        outcome: set('cancelled'),
        exitCode,
      };
    case 'completed':
    case 'done': {
      if ((exitCode !== undefined && exitCode !== 0) || isErrorFlag) {
        return {
          state: set('failed'),
          outcome: set('failed'),
          exitCode,
          isNonZeroExit: exitCode !== undefined && exitCode !== 0,
        };
      }
      if (exitCode === 0 || isExplicitOkFlag) {
        return {
          state: set('finished'),
          outcome: set('succeeded'),
          exitCode,
        };
      }
      // Observable terminal state `finished`, but do NOT fabricate `succeeded` when wire omitted exit/outcome!
      return {
        state: set('finished'),
        outcome: omit(),
        outcomeReasonCode: 'outcome_not_reported_by_wire',
        exitCode,
      };
    }
    default:
      return {
        state: set('unknown'),
        stateReasonCode: rawStatus ? `unrecognized_wire_status:${rawStatus.slice(0, 48)}` : 'empty_wire_status',
        outcome: omit(),
        exitCode,
      };
  }
}

function classifyWorkKindAndBlocking(
  update: Record<string, unknown>,
  rawInput: Record<string, unknown> | null,
  strictMode: boolean,
): {
  kind: PatchField<NativeWorkKind>;
  blocking: PatchField<Blocking>;
  matchedRuleIds: string[];
} {
  const matchedRuleIds: string[] = ['acp-v1-standard-session-update'];
  const title = typeof update.title === 'string' ? update.title.trim() : '';

  if (rawInput) {
    const isDaemonExplicit = rawInput.IsDaemon === true || rawInput.isDaemon === true;
    if (isDaemonExplicit) {
      matchedRuleIds.push('agy-v1-explicit-background-fields');
      return {
        kind: set('daemon'),
        blocking: set('detached'),
        matchedRuleIds,
      };
    }

    const hasScheduleFields =
      typeof rawInput.CronExpression === 'string' ||
      (typeof rawInput.DurationSeconds === 'number' && Number.isFinite(rawInput.DurationSeconds));
    if (hasScheduleFields) {
      matchedRuleIds.push('agy-v1-schedule-fields');
      return {
        kind: set('schedule'),
        blocking: set('detached'),
        matchedRuleIds,
      };
    }

    const isExplicitFiniteBg =
      rawInput.isBackground === true ||
      (typeof rawInput.backgroundTaskId === 'string' && rawInput.backgroundTaskId.trim().length > 0);
    if (isExplicitFiniteBg) {
      matchedRuleIds.push('agy-v1-explicit-background-fields');
      return {
        kind: set('finite_command'),
        blocking: set('confirmed_blocking'),
        matchedRuleIds,
      };
    }
  }

  // Non-strict heuristic compatibility rules (disabled in strictMode)
  if (!strictMode && title) {
    if (/invoke_subagent/i.test(title)) {
      matchedRuleIds.push('agy-v1-subagent-launch-fields');
      return {
        kind: set('subagent'),
        blocking: set('unknown'),
        matchedRuleIds,
      };
    }
    if (/^schedule\b/i.test(title)) {
      matchedRuleIds.push('agy-v1-schedule-fields');
      return {
        kind: set('schedule'),
        blocking: set('detached'),
        matchedRuleIds,
      };
    }
  }

  // If this is a partial `tool_call_update` with no classification fields, omit so prior per-ID values are preserved!
  const updateType = String(update.sessionUpdate ?? update.type ?? '');
  if (updateType === 'tool_call_update') {
    return {
      kind: omit(),
      blocking: omit(),
      matchedRuleIds,
    };
  }

  return {
    kind: set('unknown'),
    blocking: set('unknown'),
    matchedRuleIds,
  };
}

export function decodeNativeIngressFrame(
  envelope: NativeIngress,
  opts?: { readonly strictMode?: boolean },
): DecodedWireFrame {
  const strictMode = opts?.strictMode ?? false;
  const wire = envelope.wire;
  if (!isRecord(wire)) {
    return {
      kind: 'unknown_frame',
      reasonCode: 'wire_not_object',
      originSession: envelope.originSession,
    };
  }

  const method = typeof wire.method === 'string' ? wire.method : undefined;
  const params = isRecord(wire.params) ? wire.params : undefined;
  const originSession =
    envelope.originSession ??
    (params && typeof params.sessionId === 'string' && params.sessionId.trim()
      ? params.sessionId.trim()
      : undefined);

  // Server-initiated JSON-RPC request (carries wire.id + wire.method)
  if ('id' in wire && isRpcId(wire.id) && method) {
    const toolCall = params && isRecord(params.toolCall) ? params.toolCall : null;
    const toolCallId =
      toolCall && typeof toolCall.toolCallId === 'string' && toolCall.toolCallId.trim()
        ? toolCall.toolCallId.trim()
        : undefined;
    const childSessionId =
      params && typeof params.childSessionId === 'string' && params.childSessionId.trim()
        ? params.childSessionId.trim()
        : undefined;
    const title =
      toolCall && typeof toolCall.title === 'string' && toolCall.title.trim()
        ? toolCall.title.trim()
        : undefined;

    return {
      kind: 'server_request',
      wireRequestId: wire.id,
      rpcIdType: typeof wire.id === 'number' ? 'number' : 'string',
      method,
      originSession,
      childSessionId,
      toolCallId,
      isInteraction: Boolean(toolCallId?.startsWith('interaction_')),
      title,
    };
  }

  if (method !== 'session/update' || !params) {
    return {
      kind: 'unknown_frame',
      method,
      reasonCode: method ? `unhandled_notification:${method.slice(0, 64)}` : 'missing_method',
      originSession,
    };
  }

  const update = isRecord(params.update) ? params.update : params;
  const sessionUpdate =
    typeof update.sessionUpdate === 'string'
      ? update.sessionUpdate
      : typeof update.type === 'string'
        ? update.type
        : '';

  switch (sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update': {
      const rawInput = isRecord(update.rawInput) ? update.rawInput : null;
      const toolCallId =
        typeof update.toolCallId === 'string' && update.toolCallId.trim().length > 0
          ? update.toolCallId.trim()
          : null;
      const backgroundTaskId: PatchField<string> =
        rawInput && 'backgroundTaskId' in rawInput
          ? rawInput.backgroundTaskId === null
            ? clear()
            : typeof rawInput.backgroundTaskId === 'string' && rawInput.backgroundTaskId.trim()
              ? set(rawInput.backgroundTaskId.trim())
              : omit()
          : omit();

      const { kind, blocking, matchedRuleIds } = classifyWorkKindAndBlocking(
        update,
        rawInput,
        strictMode,
      );
      const { state, stateReasonCode, outcome, outcomeReasonCode, exitCode, isNonZeroExit } =
        decodeToolStatusAndOutcome(update);
      if (outcome.op === 'set' || outcomeReasonCode) {
        matchedRuleIds.push('agy-v1-tool-outcome-explicit-only');
      }

      const unknownFields = Object.keys(update).filter((k) => !KNOWN_TOOL_UPDATE_KEYS.has(k));
      const childSessionId =
        typeof params.childSessionId === 'string' && params.childSessionId.trim()
          ? params.childSessionId.trim()
          : typeof update.childSessionId === 'string' && update.childSessionId.trim()
            ? update.childSessionId.trim()
            : undefined;

      const patch: DecodedToolPatch = {
        updateKind: sessionUpdate,
        toolCallId,
        backgroundTaskId,
        kind,
        blocking,
        state,
        ...(stateReasonCode ? { stateReasonCode } : {}),
        outcome,
        ...(outcomeReasonCode ? { outcomeReasonCode } : {}),
        observedLabel: extractLabelPatch(update, rawInput),
        ...(typeof update.title === 'string' && update.title.trim() ? { title: update.title.trim() } : {}),
        ...(typeof update.kind === 'string' && update.kind.trim() ? { toolKind: update.kind.trim() } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        matchedRuleIds,
        unknownFields,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(isNonZeroExit ? { isNonZeroExit: true } : {}),
        ...(extractTextFromRawOutput(update.rawOutput)
          ? { outputSummary: extractTextFromRawOutput(update.rawOutput) }
          : {}),
      };

      return {
        kind: 'tool_patch',
        patch,
        originSession,
      };
    }

    case 'agent_message_chunk': {
      const content = isRecord(update.content) ? update.content : null;
      const text = content && typeof content.text === 'string' ? content.text : '';
      const wakeEpochHint =
        typeof update.experimentalWakeEpoch === 'number' && Number.isInteger(update.experimentalWakeEpoch)
          ? update.experimentalWakeEpoch
          : undefined;
      const unknownFields = Object.keys(update).filter((k) => !KNOWN_MESSAGE_CHUNK_KEYS.has(k));
      return {
        kind: 'assistant_chunk',
        text,
        ...(wakeEpochHint !== undefined ? { wakeEpochHint } : {}),
        originSession,
        unknownFields,
      };
    }

    case 'agent_thought_chunk': {
      const content = isRecord(update.content) ? update.content : null;
      const text = content && typeof content.text === 'string' ? content.text : '';
      return {
        kind: 'thought_chunk',
        text,
        originSession,
      };
    }

    case 'usage_update': {
      const used = typeof update.used === 'number' && Number.isFinite(update.used) ? update.used : undefined;
      const size = typeof update.size === 'number' && Number.isFinite(update.size) ? update.size : undefined;
      return {
        kind: 'usage_update',
        ...(used !== undefined ? { used } : {}),
        ...(size !== undefined ? { size } : {}),
        originSession,
      };
    }

    case 'session_info_update':
    case 'available_commands_update':
    case 'config_option_update':
    case 'plan':
      return {
        kind: 'metadata_update',
        updateType: sessionUpdate,
        originSession,
      };

    default:
      return {
        kind: 'unknown_frame',
        method,
        sessionUpdate: sessionUpdate || undefined,
        reasonCode: sessionUpdate
          ? `unrecognized_session_update:${sessionUpdate.slice(0, 64)}`
          : 'missing_session_update_type',
        originSession,
      };
  }
}
