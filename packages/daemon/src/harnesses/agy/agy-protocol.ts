import type { UserQuestionOption, UserQuestionSpec } from '@harnessmate/protocol';
import type { AcpPermissionOption } from '../acp/strict-acp-adapter.js';
import type { NormalizedAdapterEvent } from '../types.js';

export const AGY_DEFAULT_ACP_PROTOCOL_VERSION = 1 as const;

/**
 * Resolves the requested ACP protocol version for AGY sessions.
 * Always defaults to v1; v2 Preview remains disabled unless explicitly opted in.
 */
export function resolveAgyRequestedProtocolVersion(flags?: {
  readonly acpV2Preview?: boolean;
}): 1 | 2 {
  return flags?.acpV2Preview === true ? 2 : AGY_DEFAULT_ACP_PROTOCOL_VERSION;
}

export function extractAgyOriginSessionId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : undefined;
}

export function supportsAgyActiveSteering(version: string | null | undefined): boolean {
  if (!version) return false;
  const match = version.trim().match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 5);
}

export function truncateAgyToolText(text: string, maxChars = 16_000): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n... [truncated ${omitted} chars by AGY protocol guard]`;
}

export function parseAgyUsageUpdate(
  update: Record<string, unknown>,
  turnId: string | null,
): NormalizedAdapterEvent | null {
  if (update.sessionUpdate !== 'usage_update' && update.type !== 'usage_update') {
    return null;
  }
  const used =
    typeof update.used === 'number' && Number.isFinite(update.used) && update.used >= 0
      ? update.used
      : undefined;
  const size =
    typeof update.size === 'number' && Number.isFinite(update.size) && update.size > 0
      ? update.size
      : undefined;
  if (used === undefined && size === undefined) return null;

  return {
    type: 'usage.updated',
    turnId,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      ...(used !== undefined ? { contextTokens: used } : {}),
      ...(size !== undefined ? { modelContextWindow: size } : {}),
    },
  };
}

export function parseAgySessionInfoUpdate(
  update: Record<string, unknown>,
): NormalizedAdapterEvent | null {
  if (update.sessionUpdate !== 'session_info_update' && update.type !== 'session_info_update') {
    return null;
  }
  const title = typeof update.title === 'string' ? update.title.trim() : '';
  if (!title) return null;
  return {
    type: 'session.title_updated',
    title,
  };
}

export function parseAgyUpdateStepsToolCall(
  update: Record<string, unknown>,
  turnId: string,
): NormalizedAdapterEvent | null {
  const kind = String(update.sessionUpdate ?? update.type ?? '');
  if (kind !== 'tool_call' && kind !== 'tool_call_update') return null;

  const title = String(update.title ?? '').trim();
  const toolName = String(update.toolName ?? '').trim();
  if (title !== 'Run update_steps' && title !== 'update_steps' && toolName !== 'update_steps') {
    return null;
  }

  const toolCallId = String(update.toolCallId ?? `agy_plan_${turnId}`);
  const rawInput =
    update.rawInput && typeof update.rawInput === 'object'
      ? (update.rawInput as Record<string, unknown>)
      : {};
  const steps = Array.isArray(rawInput.steps)
    ? rawInput.steps
        .map((s) => {
          if (!s || typeof s !== 'object') return null;
          const rec = s as { title?: unknown; status?: unknown };
          return {
            title: String(rec.title ?? '').trim(),
            status: String(rec.status ?? 'pending'),
          };
        })
        .filter((s): s is { title: string; status: string } => Boolean(s?.title))
    : [];

  const summaryLines = steps.map((s) => `[${s.status}] ${s.title}`);
  const statusStr = String(update.status ?? '');
  const status: 'pending' | 'running' | 'completed' | 'failed' =
    statusStr === 'failed' || statusStr === 'cancelled'
      ? 'failed'
      : statusStr === 'completed'
        ? 'completed'
        : 'running';

  return {
    type: 'turn_block.ext',
    turnId,
    itemId: `agy_plan_${toolCallId}`,
    blockType: 'ext:agy.plan',
    title: 'AGY 执行步骤',
    fallbackSummary: summaryLines.join('\n') || '更新任务执行清单',
    status,
    payload: {
      toolCallId,
      steps,
    },
  };
}

export function parseAgyInteractionPermission(
  params: Record<string, unknown>,
  options: AcpPermissionOption[],
): { summary: string; questionSpec: UserQuestionSpec } | null {
  const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
  const toolCallId = String(toolCall.toolCallId ?? '');
  if (!toolCallId.startsWith('interaction_')) {
    return null;
  }

  const rawInput =
    toolCall.rawInput && typeof toolCall.rawInput === 'object'
      ? (toolCall.rawInput as Record<string, unknown>)
      : {};
  const questionText =
    (typeof rawInput.question === 'string' && rawInput.question.trim()) ||
    (typeof toolCall.title === 'string' && toolCall.title.trim()) ||
    'AGY 请求进一步确认或选择';

  const mappedOptions: UserQuestionOption[] = options
    .filter((o) => o && typeof o.optionId === 'string' && o.optionId.trim().length > 0)
    .map((o) => ({
      id: o.optionId,
      label: o.name?.trim() || o.optionId,
      ...(typeof o._meta?.['agy.security.warning'] === 'string'
        ? { description: o._meta['agy.security.warning'] }
        : {}),
    }));

  return {
    summary: questionText,
    questionSpec: {
      question: questionText,
      selectionMode: mappedOptions.length > 0 ? 'single' : 'free_text',
      allowFreeText: mappedOptions.length === 0,
      ...(mappedOptions.length > 0 ? { options: mappedOptions } : {}),
    },
  };
}

export function parseAgyBackgroundOrSubagentUpdate(
  update: Record<string, unknown>,
  turnId: string,
): { event: NormalizedAdapterEvent; keepsBackgroundAlive?: boolean } | null {
  const kind = String(update.sessionUpdate ?? update.type ?? '');
  if (kind !== 'tool_call' && kind !== 'tool_call_update') return null;

  const title = String(update.title ?? '').trim();
  const toolCallId = String(update.toolCallId ?? '');
  if (!toolCallId) return null;

  const rawInput =
    update.rawInput && typeof update.rawInput === 'object'
      ? (update.rawInput as Record<string, unknown>)
      : {};
  const rawStatus = String(update.status ?? '');
  const status: 'pending' | 'running' | 'completed' | 'failed' =
    rawStatus === 'failed' || rawStatus === 'cancelled'
      ? 'failed'
      : rawStatus === 'completed'
        ? 'completed'
        : 'running';

  if (/invoke_subagent/i.test(title)) {
    const role = typeof rawInput.Role === 'string' ? rawInput.Role : undefined;
    const typeName = typeof rawInput.TypeName === 'string' ? rawInput.TypeName : undefined;
    return {
      event: {
        type: 'turn_block.ext',
        turnId,
        itemId: `agy_subagent_${toolCallId}`,
        blockType: 'ext:agy.subagent_batch',
        title: role ? `子 Agent · ${role}` : 'AGY 子 Agent 委派',
        fallbackSummary: typeName ? `${typeName}: ${role ?? title}` : title,
        status,
        payload: {
          toolCallId,
          role,
          typeName,
        },
      },
    };
  }

  const isSchedule = /schedule/i.test(title) || 'CronExpression' in rawInput || 'DurationSeconds' in rawInput;
  const isBgCommand =
    isSchedule ||
    rawInput.isBackground === true ||
    rawInput.IsDaemon === true ||
    typeof rawInput.backgroundTaskId === 'string';
  if (isBgCommand) {
    const keepsAlive = status === 'running' || rawInput.IsDaemon === true;
    return {
      keepsBackgroundAlive: keepsAlive,
      event: {
        type: 'turn_block.ext',
        turnId,
        itemId: `agy_bgtask_${toolCallId}`,
        blockType: 'ext:agy.background_task',
        title: isSchedule ? 'AGY 定时 / 后台调度' : 'AGY 后台命令任务',
        fallbackSummary: String(rawInput.Prompt ?? rawInput.CommandLine ?? title),
        status,
        payload: {
          toolCallId,
          isSchedule,
          isDaemon: rawInput.IsDaemon === true,
          cronExpression: typeof rawInput.CronExpression === 'string' ? rawInput.CronExpression : undefined,
        },
      },
    };
  }

  if (/^\/?goal\b/i.test(title)) {
    return {
      event: {
        type: 'turn_block.ext',
        turnId,
        itemId: `agy_goal_${toolCallId}`,
        blockType: 'ext:agy.goal_status',
        title: 'AGY 原生 Goal 状态',
        fallbackSummary: title,
        status,
        payload: { toolCallId, rawInput },
      },
    };
  }

  return null;
}
