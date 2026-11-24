import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  CanonicalEvent,
  ContextInjectionDriver,
  HarnessKind,
  ToolKind,
  TurnBlockRecord,
} from '@harnessmate/protocol';
import type { TurnBlock } from './work-groups';

export interface ProjectedToolCall {
  toolCallId: string;
  toolName: string;
  toolKind: ToolKind;
  summary: string;
  input: unknown;
  output: string;
  diff: string;
  outputOmitted?: boolean;
  omittedBytes?: number;
  status: 'running' | 'success' | 'error' | 'cancelled';
  startedAt: number;
  completedAt?: number;
}

export interface ProjectedTurn {
  kind: 'turn';
  turnId: string;
  harnessId?: string;
  harnessKind?: HarnessKind;
  model?: string | null;
  actualModel?: string | null;
  userText: string;
  userAttachments: Attachment[];
  expandedCommand?: string | null;
  handoffSnapshots?: Array<{
    seq: number;
    driver: ContextInjectionDriver;
    content: string;
    sourceHarnesses: string[];
    snapshotId: string;
    accepted?: boolean;
  }>;
  userTimestamp: number;
  thinking: string;
  thinkingDone: boolean;
  assistantText: string;
  tools: ProjectedToolCall[];
  approvals: ApprovalRequest[];
  /** Chronologically interleaved ordered TurnBlocks (V2 Message Studio projection). */
  blocks: TurnBlock[];
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  errorMessage?: string;
  failureClass?: string | null;
  resetsAt?: number | null;
}

export interface ProjectedSwitchEvent {
  kind: 'switch';
  seq: number;
  createdAt: number;
  fromHarnessId: string;
  fromHarnessKind: HarnessKind;
  toHarnessId: string;
  toHarnessKind: HarnessKind;
  toModel: string | null;
  syncedUpToSeq: number;
  currentLastSeq: number;
  unsyncedTurnCount: number;
  estimatedTokens: number;
  driverPlanned: ContextInjectionDriver;
  isWarmBinding: boolean;
  gitAnchor: string | null;
}

export type ProjectedTimelineItem = ProjectedTurn | ProjectedSwitchEvent;

export interface DiagnosticEntry {
  seq: number;
  level: 'info' | 'warn' | 'error';
  stream: string;
  message: string;
  createdAt: number;
}

export interface ProjectedTimeline {
  items: ProjectedTimelineItem[];
  turns: ProjectedTurn[];
  diagnostics: DiagnosticEntry[];
  pendingApprovals: ApprovalRequest[];
}

const KNOWN_STANDARD_RECORD_TYPES = new Set([
  'user_message',
  'assistant_text',
  'reasoning',
  'command_execution',
  'file_change',
  'tool_call',
  'approval_request',
  'html_render',
  'handoff_card',
  'system_notice',
  'checkpoint_marker',
]);

/**
 * Converts a persisted `TurnBlockRecord` from `GET /api/v1/sessions/:id/items`
 * into a frontend `TurnBlock` while preserving unknown / `ext:*` blocks safely.
 */
export function turnBlockRecordToBlock(record: TurnBlockRecord): TurnBlock {
  const base = {
    blockId: record.itemId,
    schemaVersion: 2 as const,
    seq: record.seq,
    turnId: record.turnId || 'turn_default',
    harnessInstanceId: record.instanceId,
    driverId: record.driverId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rawRef: record.rawRef ?? null,
  };
  const p = record.payload ?? {};

  if (record.blockType === 'assistant_text') {
    return {
      ...base,
      type: 'assistant_text',
      text: record.textBody,
      streaming: record.status === 'running',
    };
  }

  if (record.blockType === 'reasoning') {
    return {
      ...base,
      type: 'reasoning',
      text: record.textBody,
      streaming: record.status === 'running',
    };
  }

  if (record.blockType === 'command_execution') {
    const toolCallId =
      typeof p.toolCallId === 'string'
        ? p.toolCallId
        : record.itemId.startsWith('tool:')
          ? record.itemId.slice(5)
          : record.itemId;
    return {
      ...base,
      type: 'command_execution',
      toolCallId,
      command: String(p.summary ?? p.command ?? record.title ?? 'Command'),
      cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
      exitCode: typeof p.exitCode === 'number' ? p.exitCode : null,
      outputPreview: record.textBody || undefined,
      diff: typeof p.diff === 'string' ? p.diff : undefined,
      input: p.input,
      outputOmitted: record.outputOmitted,
      omittedBytes: record.omittedBytes,
    };
  }

  if (record.blockType === 'file_change') {
    const files = Array.isArray(p.files)
      ? (p.files as Array<{ path: string; changeKind: 'add' | 'update' | 'delete' | 'rename'; additions?: number; deletions?: number }>)
      : [];
    return {
      ...base,
      type: 'file_change',
      toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : undefined,
      summary: record.title || String(p.summary ?? 'File changes'),
      files,
      diff: typeof p.diff === 'string' ? p.diff : record.textBody || undefined,
      outputOmitted: record.outputOmitted,
      omittedBytes: record.omittedBytes,
    };
  }

  if (record.blockType === 'tool_call') {
    const toolCallId =
      typeof p.toolCallId === 'string'
        ? p.toolCallId
        : record.itemId.startsWith('tool:')
          ? record.itemId.slice(5)
          : record.itemId;
    return {
      ...base,
      type: 'tool_call',
      toolCallId,
      toolName: String(p.toolName ?? record.title ?? 'Tool'),
      toolKind: (p.toolKind as ToolKind) ?? 'other',
      summary: String(p.summary ?? record.title ?? 'Tool call'),
      input: p.input,
      outputPreview: record.textBody || undefined,
      diff: typeof p.diff === 'string' ? p.diff : undefined,
      outputOmitted: record.outputOmitted,
      omittedBytes: record.omittedBytes,
      parentToolUseId: typeof p.parentToolUseId === 'string' ? p.parentToolUseId : null,
    };
  }

  if (record.blockType === 'html_render') {
    return {
      ...base,
      type: 'html_render',
      renderId: String(p.renderId ?? record.itemId),
      title: record.title || String(p.title ?? 'HTML Preview'),
      html: typeof p.html === 'string' ? p.html : record.textBody,
      preferredHeightPx: typeof p.preferredHeightPx === 'number' ? p.preferredHeightPx : undefined,
      allowFullscreen: p.allowFullscreen !== false,
    };
  }

  if (record.blockType === 'system_notice') {
    const lvl = p.level === 'warn' || p.level === 'error' ? p.level : 'info';
    return {
      ...base,
      type: 'system_notice',
      level: lvl,
      message: record.textBody || String(p.message ?? record.title),
      code: typeof p.code === 'string' ? p.code : undefined,
    };
  }

  if (record.blockType === 'checkpoint_marker') {
    const phase =
      p.phase === 'turn_pre' ||
      p.phase === 'turn_post' ||
      p.phase === 'pre_revert' ||
      p.phase === 'manual'
        ? p.phase
        : 'turn_post';
    return {
      ...base,
      type: 'checkpoint_marker',
      checkpointId: String(p.checkpointId ?? record.itemId),
      turnSeq: typeof p.turnSeq === 'number' ? p.turnSeq : record.seq,
      phase,
      gitRef: String(p.gitRef ?? ''),
      treeSha: String(p.treeSha ?? ''),
      filesChanged: typeof p.filesChanged === 'number' ? p.filesChanged : 0,
      insertions: typeof p.insertions === 'number' ? p.insertions : 0,
      deletions: typeof p.deletions === 'number' ? p.deletions : 0,
      skippedLargeFiles: Array.isArray(p.skippedLargeFiles)
        ? p.skippedLargeFiles.map(String)
        : [],
    };
  }

  if (record.blockType.startsWith('ext:')) {
    return {
      ...base,
      type: record.blockType as `ext:${string}`,
      title: record.title || record.blockType,
      fallbackSummary: record.textBody || String(p.fallbackSummary ?? ''),
      payload: p,
    };
  }

  // Forward-compatible fallback for any future / unknown block type
  return {
    ...base,
    type: 'unknown_block',
    originalType: record.blockType,
    title: record.title || record.blockType,
    fallbackSummary: record.textBody || '',
    payload: p,
    unknownBlock: true,
  };
}

/**
 * Merges materialized `TurnBlockRecord[]` (e.g. `ext:*`, `html_render`, `outputOmitted`
 * metadata from `GET /api/v1/sessions/:id/items`) into a projected timeline without
 * duplicating existing blocks derived from `CanonicalEvent[]`.
 */
export function mergeTurnBlockRecords(
  timeline: ProjectedTimeline,
  records: readonly TurnBlockRecord[],
): ProjectedTimeline {
  if (!records || records.length === 0) return timeline;
  const byTurn = new Map<string, TurnBlockRecord[]>();
  for (const rec of records) {
    if (rec.blockType === 'user_message') continue;
    const tid = rec.turnId || 'turn_default';
    const arr = byTurn.get(tid) ?? [];
    arr.push(rec);
    byTurn.set(tid, arr);
  }
  if (byTurn.size === 0) return timeline;

  let changed = false;
  const turnReplacements = new Map<string, ProjectedTurn>();

  for (const turn of timeline.turns) {
    const turnRecords = byTurn.get(turn.turnId);
    if (!turnRecords || turnRecords.length === 0) continue;

    const blocks = turn.blocks.map((b) => ({ ...b }));
    const blockIdxById = new Map<string, number>();
    blocks.forEach((b, idx) => blockIdxById.set(b.blockId, idx));
    const toolIdxByCallId = new Map<string, number>();
    blocks.forEach((b, idx) => {
      if ((b.type === 'tool_call' || b.type === 'command_execution') && b.toolCallId) {
        toolIdxByCallId.set(b.toolCallId, idx);
      }
    });

    let turnDirty = false;
    for (const rec of turnRecords) {
      const converted = turnBlockRecordToBlock(rec);
      const existingById = blockIdxById.get(rec.itemId);
      const toolCallId =
        typeof rec.payload?.toolCallId === 'string'
          ? rec.payload.toolCallId
          : rec.itemId.startsWith('tool:')
            ? rec.itemId.slice(5)
            : undefined;
      const existingByTool = toolCallId ? toolIdxByCallId.get(toolCallId) : undefined;
      const matchIdx = existingById ?? existingByTool;

      if (matchIdx !== undefined) {
        const cur = blocks[matchIdx]!;
        // Enrich existing tool/command block with omitted metadata if record has it
        if (
          (cur.type === 'tool_call' || cur.type === 'command_execution') &&
          rec.outputOmitted &&
          !cur.outputOmitted
        ) {
          blocks[matchIdx] = {
            ...cur,
            outputOmitted: true,
            omittedBytes: rec.omittedBytes,
          };
          turnDirty = true;
        }
        continue;
      }

      // Skip duplicating assistant_text or reasoning already projected from CanonicalEvents
      if (rec.blockType === 'assistant_text' && blocks.some((b) => b.type === 'assistant_text')) {
        continue;
      }
      if (rec.blockType === 'reasoning' && blocks.some((b) => b.type === 'reasoning')) {
        continue;
      }

      // Insert ext:*, html_render, checkpoint_marker, unknown blocks, or missing records in chronological order
      if (
        rec.blockType.startsWith('ext:') ||
        rec.blockType === 'html_render' ||
        rec.blockType === 'checkpoint_marker' ||
        rec.blockType === 'system_notice' ||
        !KNOWN_STANDARD_RECORD_TYPES.has(rec.blockType) ||
        blocks.length === 0
      ) {
        blocks.push(converted);
        blockIdxById.set(converted.blockId, blocks.length - 1);
        turnDirty = true;
      }
    }

    if (turnDirty) {
      blocks.sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);
      turnReplacements.set(turn.turnId, { ...turn, blocks });
      changed = true;
    }
  }

  if (!changed) return timeline;

  return {
    ...timeline,
    items: timeline.items.map((item) =>
      item.kind === 'turn' ? turnReplacements.get(item.turnId) ?? item : item,
    ),
    turns: timeline.turns.map((turn) => turnReplacements.get(turn.turnId) ?? turn),
  };
}

export function projectSessionEvents(
  events: CanonicalEvent[],
  fallbackHarness?: { id: string; kind: HarnessKind },
  turnItems?: readonly TurnBlockRecord[],
): ProjectedTimeline {
  const base = createSessionEventProjector()(events, fallbackHarness);
  return turnItems && turnItems.length > 0 ? mergeTurnBlockRecords(base, turnItems) : base;
}

export function createSessionEventProjector() {
  let projection = createProjection();
  let previous: CanonicalEvent[] = [];
  let harnessId: string | undefined;
  let harnessKind: HarnessKind | undefined;
  return (
    events: CanonicalEvent[],
    fallbackHarness?: { id: string; kind: HarnessKind },
  ): ProjectedTimeline => {
    // Live batches retain event identities. Merging missing history can change the prefix.
    const appendOnly =
      events.length >= previous.length &&
      (!previous.length ||
        (events[0] === previous[0] && events[previous.length - 1] === previous.at(-1)));
    if (!appendOnly || fallbackHarness?.id !== harnessId || fallbackHarness?.kind !== harnessKind) {
      projection = createProjection(fallbackHarness);
      previous = [];
      harnessId = fallbackHarness?.id;
      harnessKind = fallbackHarness?.kind;
    }
    projection.apply(events, previous.length);
    previous = events;
    return projection.snapshot();
  };
}

function classifyFailureFromPayload(p: Record<string, unknown>, message: string): string {
  if (typeof p.failureClass === 'string' && p.failureClass) return p.failureClass;
  if (typeof p.code === 'string' && p.code) return p.code;
  if (/rate.?limit|usage.?limit|quota|too many requests|429/i.test(message)) return 'usage_limit';
  if (/unavailable|overloaded|503|502|connection refused/i.test(message)) return 'provider_unavailable';
  return 'provider_error';
}

function createProjection(fallbackHarness?: { id: string; kind: HarnessKind }) {
  const items: ProjectedTimelineItem[] = [];
  const turns: ProjectedTurn[] = [];
  const turnMap = new Map<string, ProjectedTurn>();
  const toolMap = new Map<string, ProjectedToolCall>();
  const toolBlockMap = new Map<string, Extract<TurnBlock, { type: 'tool_call' | 'command_execution' }>>();
  const activeAssistantBlockMap = new Map<string, Extract<TurnBlock, { type: 'assistant_text' }>>();
  const activeReasoningBlockMap = new Map<string, Extract<TurnBlock, { type: 'reasoning' }>>();
  const approvalMap = new Map<string, ApprovalRequest>();
  const diagnostics: DiagnosticEntry[] = [];
  const toolOwners = new Map<string, ProjectedTurn>();
  const approvalOwners = new Map<string, ProjectedTurn>();
  const pending = new Set<string>();
  const snapshots = new WeakMap<ProjectedTurn, ProjectedTurn>();
  const dirty = new Set<ProjectedTurn>();
  let result: ProjectedTimeline = { items: [], turns: [], diagnostics: [], pendingApprovals: [] };

  const getOrCreateTurn = (turnId: string | null, ts: number): ProjectedTurn => {
    const key = turnId || 'turn_default';
    let turn = turnMap.get(key);
    if (!turn) {
      turn = {
        kind: 'turn',
        turnId: key,
        harnessId: fallbackHarness?.id,
        harnessKind: fallbackHarness?.kind,
        model: null,
        actualModel: null,
        userText: '',
        userAttachments: [],
        expandedCommand: null,
        userTimestamp: ts,
        thinking: '',
        thinkingDone: false,
        assistantText: '',
        tools: [],
        approvals: [],
        blocks: [],
        status: 'running',
      };
      turnMap.set(key, turn);
      turns.push(turn);
      items.push(turn);
    }
    dirty.add(turn);
    return turn;
  };

  const applyTurnAttribution = (turn: ProjectedTurn, p: Record<string, unknown>) => {
    if (typeof p.harnessId === 'string' && p.harnessId) {
      turn.harnessId = p.harnessId;
    }
    if (typeof p.harnessKind === 'string' && p.harnessKind) {
      turn.harnessKind = p.harnessKind as HarnessKind;
    }
    if (typeof p.model === 'string' && p.model) {
      turn.model = p.model;
    }
    if (typeof p.actualModel === 'string' && p.actualModel) {
      turn.actualModel = p.actualModel;
    }
  };

  const closeActiveTextBlocks = (turnId: string) => {
    const prevAssistant = activeAssistantBlockMap.get(turnId);
    if (prevAssistant) {
      prevAssistant.streaming = false;
      (prevAssistant as { status: string }).status = 'completed';
      activeAssistantBlockMap.delete(turnId);
    }
    const prevReasoning = activeReasoningBlockMap.get(turnId);
    if (prevReasoning) {
      prevReasoning.streaming = false;
      (prevReasoning as { status: string }).status = 'completed';
      activeReasoningBlockMap.delete(turnId);
    }
  };

  function applyEvent(ev: CanonicalEvent) {
    const p = ev.payload;

    switch (ev.type) {
      case 'handoff.snapshot': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        const snap = {
          seq: ev.seq,
          driver: p.driver as ContextInjectionDriver,
          snapshotId: String(p.snapshotId ?? ''),
          sourceHarnesses: Array.isArray(p.sourceHarnesses)
            ? p.sourceHarnesses.filter((value): value is string => typeof value === 'string')
            : [],
          content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content, null, 2),
        };
        (turn.handoffSnapshots ??= []).push(snap);
        break;
      }
      case 'handoff.snapshot_delivered': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        const dispatched = turn.handoffSnapshots?.findLast(
          (item) => item.snapshotId === p.snapshotId && item.driver === p.driver,
        );
        if (dispatched) dispatched.accepted = true;
        break;
      }
      case 'session.harness_switched': {
        items.push({
          kind: 'switch',
          seq: ev.seq,
          createdAt: ev.createdAt,
          fromHarnessId: String(p.fromHarnessId ?? ''),
          fromHarnessKind: (p.fromHarnessKind as HarnessKind) ?? 'acp',
          toHarnessId: String(p.toHarnessId ?? ''),
          toHarnessKind: (p.toHarnessKind as HarnessKind) ?? 'acp',
          toModel: typeof p.toModel === 'string' ? p.toModel : null,
          syncedUpToSeq: Number(p.syncedUpToSeq ?? 0),
          currentLastSeq: Number(p.currentLastSeq ?? 0),
          unsyncedTurnCount: Number(p.unsyncedTurnCount ?? 0),
          estimatedTokens: Number(p.estimatedTokens ?? 0),
          driverPlanned: (p.driverPlanned as ContextInjectionDriver) ?? 'prompt_envelope',
          isWarmBinding: Boolean(p.isWarmBinding),
          gitAnchor: typeof p.gitAnchor === 'string' ? p.gitAnchor : null,
        });
        break;
      }

      case 'session.model_confirmed': {
        if (ev.turnId) {
          const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
          applyTurnAttribution(turn, p);
        }
        break;
      }

      case 'message.user': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        turn.userText = String(p.text ?? '');
        turn.userAttachments = Array.isArray(p.attachments) ? (p.attachments as Attachment[]) : [];
        turn.expandedCommand = typeof p.expandedCommand === 'string' ? p.expandedCommand : null;
        turn.userTimestamp = ev.createdAt;
        break;
      }

      case 'turn.started': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        turn.status = 'running';
        break;
      }

      case 'thinking.delta': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        const delta = String(p.text ?? '');
        turn.thinking += delta;
        let rBlock = activeReasoningBlockMap.get(turn.turnId);
        if (!rBlock) {
          // Close any open assistant block before interleaving a new reasoning block
          const openAssistant = activeAssistantBlockMap.get(turn.turnId);
          if (openAssistant) {
            openAssistant.streaming = false;
            (openAssistant as { status: string }).status = 'completed';
            activeAssistantBlockMap.delete(turn.turnId);
          }
          rBlock = {
            blockId: `${turn.turnId}:reasoning:${ev.seq}`,
            schemaVersion: 2,
            seq: ev.seq,
            turnId: turn.turnId,
            harnessInstanceId: turn.harnessId ?? fallbackHarness?.id ?? 'default',
            driverId: turn.harnessKind ?? fallbackHarness?.kind ?? 'acp',
            type: 'reasoning',
            text: '',
            streaming: true,
            status: 'running',
            createdAt: ev.createdAt,
            updatedAt: ev.createdAt,
          };
          activeReasoningBlockMap.set(turn.turnId, rBlock);
          turn.blocks.push(rBlock);
        }
        rBlock.text += delta;
        (rBlock as { updatedAt: number }).updatedAt = ev.createdAt;
        break;
      }

      case 'thinking.completed': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        const finalThinking = typeof p.text === 'string' ? p.text : '';
        if (finalThinking.length >= turn.thinking.length) {
          turn.thinking = finalThinking;
        }
        turn.thinkingDone = true;
        const rBlock = activeReasoningBlockMap.get(turn.turnId);
        if (rBlock) {
          if (finalThinking.length >= rBlock.text.length) rBlock.text = finalThinking;
          rBlock.streaming = false;
          (rBlock as { status: string }).status = 'completed';
          (rBlock as { updatedAt: number }).updatedAt = ev.createdAt;
          activeReasoningBlockMap.delete(turn.turnId);
        } else if (finalThinking) {
          turn.blocks.push({
            blockId: `${turn.turnId}:reasoning`,
            schemaVersion: 2,
            seq: ev.seq,
            turnId: turn.turnId,
            harnessInstanceId: turn.harnessId ?? fallbackHarness?.id ?? 'default',
            driverId: turn.harnessKind ?? fallbackHarness?.kind ?? 'acp',
            type: 'reasoning',
            text: finalThinking,
            streaming: false,
            status: 'completed',
            createdAt: ev.createdAt,
            updatedAt: ev.createdAt,
          });
        }
        break;
      }

      case 'message.assistant.delta': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        const delta = String(p.text ?? '');
        turn.assistantText += delta;
        const openReasoning = activeReasoningBlockMap.get(turn.turnId);
        if (openReasoning) {
          openReasoning.streaming = false;
          (openReasoning as { status: string }).status = 'completed';
          activeReasoningBlockMap.delete(turn.turnId);
        }
        let aBlock = activeAssistantBlockMap.get(turn.turnId);
        if (!aBlock) {
          aBlock = {
            blockId: `${turn.turnId}:assistant:${ev.seq}`,
            schemaVersion: 2,
            seq: ev.seq,
            turnId: turn.turnId,
            harnessInstanceId: turn.harnessId ?? fallbackHarness?.id ?? 'default',
            driverId: turn.harnessKind ?? fallbackHarness?.kind ?? 'acp',
            type: 'assistant_text',
            text: '',
            streaming: true,
            status: 'running',
            createdAt: ev.createdAt,
            updatedAt: ev.createdAt,
          };
          activeAssistantBlockMap.set(turn.turnId, aBlock);
          turn.blocks.push(aBlock);
        }
        aBlock.text += delta;
        (aBlock as { updatedAt: number }).updatedAt = ev.createdAt;
        break;
      }

      case 'message.assistant.completed': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        const finalText = String(p.text ?? '');
        if (finalText.length >= turn.assistantText.length) {
          turn.assistantText = finalText;
        }
        const aBlock = activeAssistantBlockMap.get(turn.turnId);
        if (aBlock) {
          if (finalText.length >= aBlock.text.length) aBlock.text = finalText;
          aBlock.streaming = false;
          (aBlock as { status: string }).status = 'completed';
          (aBlock as { updatedAt: number }).updatedAt = ev.createdAt;
          activeAssistantBlockMap.delete(turn.turnId);
        } else if (finalText) {
          turn.blocks.push({
            blockId: `${turn.turnId}:assistant:${String(p.messageId ?? ev.seq)}`,
            schemaVersion: 2,
            seq: ev.seq,
            turnId: turn.turnId,
            harnessInstanceId: turn.harnessId ?? fallbackHarness?.id ?? 'default',
            driverId: turn.harnessKind ?? fallbackHarness?.kind ?? 'acp',
            type: 'assistant_text',
            text: finalText,
            streaming: false,
            status: 'completed',
            createdAt: ev.createdAt,
            updatedAt: ev.createdAt,
          });
        }
        break;
      }

      case 'tool.call.started': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        closeActiveTextBlocks(turn.turnId);
        const toolCallId = String(p.toolCallId ?? `tc_${ev.seq}`);
        let tool = toolMap.get(toolCallId);
        if (!tool) {
          const toolName = String(p.toolName ?? 'Tool');
          const toolKind = (p.toolKind as ToolKind) ?? 'other';
          const summary = String(p.summary ?? p.toolName ?? 'Tool call');
          tool = {
            toolCallId,
            toolName,
            toolKind,
            summary,
            input: p.input ?? null,
            output: '',
            diff: '',
            status: 'running',
            startedAt: ev.createdAt,
          };
          toolMap.set(toolCallId, tool);
          toolOwners.set(toolCallId, turn);
          turn.tools.push(tool);

          const block: Extract<TurnBlock, { type: 'tool_call' | 'command_execution' }> =
            toolKind === 'shell'
              ? {
                  blockId: `tool:${toolCallId}`,
                  schemaVersion: 2,
                  seq: ev.seq,
                  turnId: turn.turnId,
                  harnessInstanceId: turn.harnessId ?? fallbackHarness?.id ?? 'default',
                  driverId: turn.harnessKind ?? fallbackHarness?.kind ?? 'acp',
                  type: 'command_execution',
                  toolCallId,
                  command: summary,
                  input: p.input ?? null,
                  outputPreview: '',
                  diff: '',
                  status: 'running',
                  createdAt: ev.createdAt,
                  updatedAt: ev.createdAt,
                }
              : {
                  blockId: `tool:${toolCallId}`,
                  schemaVersion: 2,
                  seq: ev.seq,
                  turnId: turn.turnId,
                  harnessInstanceId: turn.harnessId ?? fallbackHarness?.id ?? 'default',
                  driverId: turn.harnessKind ?? fallbackHarness?.kind ?? 'acp',
                  type: 'tool_call',
                  toolCallId,
                  toolName,
                  toolKind,
                  summary,
                  input: p.input ?? null,
                  outputPreview: '',
                  diff: '',
                  parentToolUseId: typeof p.parentToolUseId === 'string' ? p.parentToolUseId : null,
                  status: 'running',
                  createdAt: ev.createdAt,
                  updatedAt: ev.createdAt,
                };
          toolBlockMap.set(toolCallId, block);
          turn.blocks.push(block);
        }
        break;
      }

      case 'tool.call.delta': {
        const toolCallId = String(p.toolCallId ?? '');
        const tool = toolMap.get(toolCallId);
        if (tool) {
          dirty.add(toolOwners.get(toolCallId)!);
          if (typeof p.outputDelta === 'string') tool.output += p.outputDelta;
          if (typeof p.diffDelta === 'string') tool.diff += p.diffDelta;
          const block = toolBlockMap.get(toolCallId);
          if (block) {
            if (typeof p.outputDelta === 'string') block.outputPreview = (block.outputPreview ?? '') + p.outputDelta;
            if (typeof p.diffDelta === 'string') block.diff = (block.diff ?? '') + p.diffDelta;
            (block as { updatedAt: number }).updatedAt = ev.createdAt;
          }
        }
        break;
      }

      case 'tool.call.completed': {
        const toolCallId = String(p.toolCallId ?? '');
        const tool = toolMap.get(toolCallId);
        if (tool) {
          dirty.add(toolOwners.get(toolCallId)!);
          const st = String(p.status ?? 'success');
          tool.status = st === 'error' ? 'error' : st === 'cancelled' ? 'cancelled' : 'success';
          if (typeof p.output === 'string' && p.output.length > 0) {
            tool.output = p.output;
          }
          if (typeof p.diff === 'string' && p.diff.length > 0) {
            tool.diff = p.diff;
          }
          if (p.outputOmitted === true) {
            tool.outputOmitted = true;
            tool.omittedBytes = typeof p.omittedBytes === 'number' ? p.omittedBytes : 0;
          }
          tool.completedAt = ev.createdAt;

          const block = toolBlockMap.get(toolCallId);
          if (block) {
            (block as { status: string }).status =
              st === 'error' ? 'failed' : st === 'cancelled' ? 'cancelled' : 'completed';
            if (typeof p.output === 'string' && p.output.length > 0) {
              block.outputPreview = p.output;
            }
            if (typeof p.diff === 'string' && p.diff.length > 0) {
              block.diff = p.diff;
            }
            if (p.outputOmitted === true) {
              block.outputOmitted = true;
              block.omittedBytes = typeof p.omittedBytes === 'number' ? p.omittedBytes : 0;
            }
            (block as { updatedAt: number }).updatedAt = ev.createdAt;
          }
        }
        break;
      }

      case 'approval.requested': {
        const approval = p.approval as ApprovalRequest | undefined;
        if (approval && approval.id) {
          const copy: ApprovalRequest = { ...approval };
          approvalMap.set(copy.id, copy);
          const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
          turn.approvals.push(copy);
          approvalOwners.set(copy.id, turn);
          if (copy.status === 'pending') pending.add(copy.id);
        }
        break;
      }

      case 'approval.resolved': {
        const approvalId = String(p.approvalId ?? '');
        const existing = approvalMap.get(approvalId);
        if (existing) {
          dirty.add(approvalOwners.get(approvalId)!);
          pending.delete(approvalId);
          const decision = (p.decision as ApprovalDecision | undefined) ?? null;
          existing.decision = decision;
          existing.status = p.status === 'expired' ? 'expired' : decision === 'deny' ? 'denied' : 'approved';
          existing.resolvedBy =
            existing.status === 'expired'
              ? null
              : ((p.resolvedBy as 'desktop' | 'mobile' | 'auto') ?? 'desktop');
          existing.comment = typeof p.comment === 'string' ? p.comment : null;
          existing.resolvedAt = typeof p.resolvedAt === 'number' ? p.resolvedAt : ev.createdAt;
        }
        break;
      }

      case 'turn.completed': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        closeActiveTextBlocks(turn.turnId);
        turn.status = 'completed';
        turn.thinkingDone = true;
        break;
      }

      case 'turn.cancelled': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        closeActiveTextBlocks(turn.turnId);
        turn.status = 'cancelled';
        turn.thinkingDone = true;
        break;
      }

      case 'turn.failed': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        closeActiveTextBlocks(turn.turnId);
        turn.status = 'failed';
        const message = String(p.message ?? 'Turn failed');
        turn.errorMessage = message;
        turn.failureClass = classifyFailureFromPayload(p, message);
        if (typeof p.resetsAt === 'number') {
          turn.resetsAt = p.resetsAt;
        }
        turn.thinkingDone = true;
        break;
      }

      case 'diagnostic.log': {
        diagnostics.push({
          seq: ev.seq,
          level: (p.level as 'info' | 'warn' | 'error') ?? 'info',
          stream: String(p.stream ?? 'protocol'),
          message: String(p.message ?? ''),
          createdAt: ev.createdAt,
        });
        break;
      }

      default:
        break;
    }
  }

  return {
    apply(events: CanonicalEvent[], offset: number) {
      for (let i = offset; i < events.length; i++) applyEvent(events[i]!);
    },
    snapshot(): ProjectedTimeline {
      const timelineChanged = dirty.size > 0 || items.length !== result.items.length;
      if (!timelineChanged && diagnostics.length === result.diagnostics.length) return result;
      for (const turn of dirty) {
        snapshots.set(turn, {
          ...turn,
          tools: turn.tools.map((tool) => ({ ...tool })),
          approvals: turn.approvals.map((approval) => ({ ...approval })),
          handoffSnapshots: turn.handoffSnapshots?.map((snapshot) => ({ ...snapshot })),
          blocks: turn.blocks.map((block) => ({ ...block })),
        });
      }
      dirty.clear();
      result = {
        items: timelineChanged
          ? items.map((item) => (item.kind === 'turn' ? snapshots.get(item)! : item))
          : result.items,
        turns: timelineChanged ? turns.map((turn) => snapshots.get(turn)!) : result.turns,
        diagnostics:
          diagnostics.length === result.diagnostics.length ? result.diagnostics : diagnostics.slice(),
        pendingApprovals: timelineChanged
          ? [...pending].map((id) => ({ ...approvalMap.get(id)! }))
          : result.pendingApprovals,
      };
      return result;
    },
  };
}
