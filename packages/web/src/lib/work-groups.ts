import type {
  ApprovalRequest,
  Attachment,
  ToolKind,
  TurnBlockRawRef,
  TurnBlockStatus,
} from '@harnessmate/protocol';

export interface TurnBlockBase {
  readonly blockId: string;
  readonly schemaVersion: 2;
  readonly seq: number;
  readonly turnId: string;
  readonly harnessInstanceId: string;
  readonly driverId: string;
  readonly status: TurnBlockStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly rawRef?: TurnBlockRawRef | null;
}

export type StandardTurnBlock =
  | (TurnBlockBase & {
      type: 'user_message';
      text: string;
      attachments: Attachment[];
      expandedCommand?: string | null;
    })
  | (TurnBlockBase & {
      type: 'assistant_text';
      text: string;
      streaming: boolean;
      phase?: 'commentary' | 'final';
    })
  | (TurnBlockBase & {
      type: 'reasoning';
      text: string;
      streaming: boolean;
      redactedSignature?: boolean;
    })
  | (TurnBlockBase & {
      type: 'command_execution';
      toolCallId: string;
      command: string;
      cwd?: string;
      exitCode?: number | null;
      outputPreview?: string;
      diff?: string;
      input?: unknown;
      outputOmitted?: boolean;
      omittedBytes?: number;
    })
  | (TurnBlockBase & {
      type: 'file_change';
      toolCallId?: string;
      summary: string;
      files: Array<{
        path: string;
        changeKind: 'add' | 'update' | 'delete' | 'rename';
        additions?: number;
        deletions?: number;
      }>;
      diff?: string;
      diffOmitted?: boolean;
      outputOmitted?: boolean;
      omittedBytes?: number;
    })
  | (TurnBlockBase & {
      type: 'tool_call';
      toolCallId: string;
      toolName: string;
      toolKind: ToolKind;
      summary: string;
      input?: unknown;
      outputPreview?: string;
      diff?: string;
      outputOmitted?: boolean;
      omittedBytes?: number;
      parentToolUseId?: string | null;
    })
  | (TurnBlockBase & {
      type: 'approval_request';
      approval: ApprovalRequest;
    })
  | (TurnBlockBase & {
      type: 'html_render';
      renderId: string;
      title: string;
      html: string;
      preferredHeightPx?: number;
      allowFullscreen?: boolean;
    })
  | (TurnBlockBase & {
      type: 'handoff_card';
      handoffId: string;
      driver: string;
      sourceHarnesses: string[];
      content: string;
      accepted?: boolean;
    })
  | (TurnBlockBase & {
      type: 'system_notice';
      level: 'info' | 'warn' | 'error';
      message: string;
      code?: string;
    });

export interface ExtensionTurnBlock extends TurnBlockBase {
  readonly type: `ext:${string}`;
  readonly title: string;
  readonly fallbackSummary: string;
  readonly payload: Record<string, unknown>;
}

export interface UnknownTurnBlock extends TurnBlockBase {
  readonly type: 'unknown_block';
  readonly originalType: string;
  readonly title: string;
  readonly fallbackSummary: string;
  readonly payload: Record<string, unknown>;
  readonly unknownBlock: true;
}

export type TurnBlock = StandardTurnBlock | ExtensionTurnBlock | UnknownTurnBlock;

export type WorkStepBlock = Extract<
  TurnBlock,
  { type: 'reasoning' | 'command_execution' | 'tool_call' | 'file_change' }
>;

export interface WorkGroupProjection {
  kind: 'work_group';
  groupId: string;
  turnId: string;
  status: 'running' | 'completed' | 'failed';
  blocks: WorkStepBlock[];
  summaryText: string;
  activeStepTitle?: string;
  durationMs: number;
  hasErrors: boolean;
  hasFileEdits: boolean;
  collapsedByDefault: boolean;
}

export type GroupedTurnSegment =
  | WorkGroupProjection
  | { kind: 'block'; block: TurnBlock };

const WORK_STEP_TYPES = new Set(['reasoning', 'command_execution', 'tool_call', 'file_change']);

export function isWorkStepBlock(block: TurnBlock): block is WorkStepBlock {
  return WORK_STEP_TYPES.has(block.type) && !('unknownBlock' in block);
}

export function isExtensionOrUnknownBlock(
  block: TurnBlock,
): block is ExtensionTurnBlock | UnknownTurnBlock {
  return block.type === 'unknown_block' || block.type.startsWith('ext:');
}

function summarizeWorkGroup(blocks: WorkStepBlock[], status: WorkGroupProjection['status']): string {
  let reads = 0;
  let edits = 0;
  let commands = 0;
  let searches = 0;
  let reasoning = 0;
  let other = 0;

  for (const b of blocks) {
    if (b.type === 'reasoning') reasoning += 1;
    else if (b.type === 'command_execution') commands += 1;
    else if (b.type === 'file_change') edits += 1;
    else if (b.type === 'tool_call') {
      if (b.toolKind === 'file_read') reads += 1;
      else if (b.toolKind === 'file_edit') edits += 1;
      else if (b.toolKind === 'shell') commands += 1;
      else if (b.toolKind === 'search' || b.toolKind === 'web') searches += 1;
      else other += 1;
    }
  }

  const prefix =
    status === 'running'
      ? `正在执行 (${blocks.length} 步)`
      : status === 'failed'
        ? `步骤异常 (${blocks.length} 步)`
        : `已完成 ${blocks.length} 个步骤`;

  const parts: string[] = [];
  if (reasoning > 0) parts.push(`思考 ${reasoning}`);
  if (reads > 0) parts.push(`读 ${reads} 文件`);
  if (edits > 0) parts.push(`改 ${edits} 文件`);
  if (commands > 0) parts.push(`运行 ${commands} 命令`);
  if (searches > 0) parts.push(`检索 ${searches}`);
  if (other > 0) parts.push(`工具 ${other}`);

  return parts.length > 0 ? `${prefix} · ${parts.join(' · ')}` : prefix;
}

function describeStepTitle(block: WorkStepBlock): string {
  if (block.type === 'reasoning') return '深度思考中...';
  if (block.type === 'command_execution') return block.command || '执行命令';
  if (block.type === 'file_change') return block.summary || '修改文件';
  return block.summary || block.toolName;
}

/**
 * Groups consecutive non-reply work steps (reasoning, commands, tools, file changes)
 * into collapsible `WorkGroupProjection` segments while preserving exact chronological
 * interleaving with `assistant_text`, `approval_request`, `html_render`, `handoff_card`,
 * `system_notice`, and `ext:*` blocks.
 */
export function groupTurnBlocks(
  blocks: readonly TurnBlock[],
  turnRunning: boolean,
): GroupedTurnSegment[] {
  const segments: GroupedTurnSegment[] = [];
  let buffer: WorkStepBlock[] = [];
  let groupIndex = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const first = buffer[0]!;
    const last = buffer[buffer.length - 1]!;
    const hasRunning = buffer.some((b) => b.status === 'running' || b.status === 'pending');
    const hasErrors = buffer.some((b) => b.status === 'failed');
    const hasFileEdits = buffer.some(
      (b) => b.type === 'file_change' || (b.type === 'tool_call' && b.toolKind === 'file_edit'),
    );
    const status: WorkGroupProjection['status'] = hasRunning
      ? 'running'
      : hasErrors
        ? 'failed'
        : 'completed';
    const runningStep = [...buffer].reverse().find((b) => b.status === 'running' || b.status === 'pending');
    const durationMs = Math.max(0, last.updatedAt - first.createdAt);

    segments.push({
      kind: 'work_group',
      groupId: `${first.turnId}:wg:${groupIndex++}`,
      turnId: first.turnId,
      status,
      blocks: buffer,
      summaryText: summarizeWorkGroup(buffer, status),
      activeStepTitle: runningStep ? describeStepTitle(runningStep) : undefined,
      durationMs,
      hasErrors,
      hasFileEdits,
      collapsedByDefault: !hasRunning && !hasErrors && !(turnRunning && groupIndex === 1 && buffer.length === 1),
    });
    buffer = [];
  };

  for (const block of blocks) {
    if (isWorkStepBlock(block)) {
      buffer.push(block);
    } else {
      flush();
      segments.push({ kind: 'block', block });
    }
  }
  flush();

  return segments;
}

// ── Per-session Scroll Position Memory ─────────────────────────────────

const SCROLL_MEMORY_PREFIX = 'hm_timeline_scroll_v1:';
const inMemoryScrollPositions = new Map<string, { scrollTop: number; followBottom: boolean }>();

export function rememberTimelinePosition(
  sessionId: string,
  scrollTop: number,
  followBottom: boolean,
): void {
  const record = { scrollTop: Math.max(0, Math.round(scrollTop)), followBottom };
  inMemoryScrollPositions.set(sessionId, record);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`${SCROLL_MEMORY_PREFIX}${sessionId}`, JSON.stringify(record));
    }
  } catch {
    // ignore storage quota errors
  }
}

export function readTimelinePosition(
  sessionId: string,
): { scrollTop: number; followBottom: boolean } | null {
  const cached = inMemoryScrollPositions.get(sessionId);
  if (cached) return cached;
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(`${SCROLL_MEMORY_PREFIX}${sessionId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { scrollTop?: number; followBottom?: boolean };
        if (typeof parsed.scrollTop === 'number') {
          const rec = { scrollTop: parsed.scrollTop, followBottom: Boolean(parsed.followBottom) };
          inMemoryScrollPositions.set(sessionId, rec);
          return rec;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ── Timeline Minimap Anchor Projection ─────────────────────────────────

export interface TimelineMinimapEntry {
  id: string;
  kind: 'turn' | 'switch';
  index: number;
  label: string;
  harnessId: string;
  harnessKind: string;
  hasFileChanges: boolean;
  failed: boolean;
  running: boolean;
}

export function buildTimelineMinimapItems(
  items: ReadonlyArray<
    | {
        kind: 'turn';
        turnId: string;
        harnessId?: string;
        harnessKind?: string;
        userText: string;
        status: string;
        tools?: Array<{ toolKind: string }>;
        blocks?: TurnBlock[];
      }
    | {
        kind: 'switch';
        seq: number;
        fromHarnessId: string;
        toHarnessId: string;
        toHarnessKind: string;
      }
  >,
  fallbackHarness: { id: string; kind: string },
): TimelineMinimapEntry[] {
  return items.map((item, index) => {
    if (item.kind === 'switch') {
      return {
        id: `sw_${item.seq}`,
        kind: 'switch',
        index,
        label: `切换引擎: ${item.fromHarnessId} → ${item.toHarnessId}`,
        harnessId: item.toHarnessId,
        harnessKind: item.toHarnessKind,
        hasFileChanges: false,
        failed: false,
        running: false,
      };
    }
    const hasFileChanges = Boolean(
      item.tools?.some((t) => t.toolKind === 'file_edit') ||
        item.blocks?.some(
          (b) => b.type === 'file_change' || (b.type === 'tool_call' && b.toolKind === 'file_edit'),
        ),
    );
    const preview = item.userText.replace(/\s+/g, ' ').trim().slice(0, 48) || `轮次 #${index + 1}`;
    return {
      id: item.turnId,
      kind: 'turn',
      index,
      label: preview,
      harnessId: item.harnessId ?? fallbackHarness.id,
      harnessKind: item.harnessKind ?? fallbackHarness.kind,
      hasFileChanges,
      failed: item.status === 'failed',
      running: item.status === 'running',
    };
  });
}
