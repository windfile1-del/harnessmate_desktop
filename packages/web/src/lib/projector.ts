import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  CanonicalEvent,
  ContextInjectionDriver,
  HarnessKind,
  ToolKind,
} from '@harnessmate/protocol';

export interface ProjectedToolCall {
  toolCallId: string;
  toolName: string;
  toolKind: ToolKind;
  summary: string;
  input: unknown;
  output: string;
  diff: string;
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
  handoffSnapshots?: Array<{ seq: number; driver: ContextInjectionDriver; content: string;
    sourceHarnesses: string[]; snapshotId: string; accepted?: boolean }>;
  userTimestamp: number;
  thinking: string;
  thinkingDone: boolean;
  assistantText: string;
  tools: ProjectedToolCall[];
  approvals: ApprovalRequest[];
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  errorMessage?: string;
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

export function projectSessionEvents(
  events: CanonicalEvent[],
  fallbackHarness?: { id: string; kind: HarnessKind },
): ProjectedTimeline {
  const items: ProjectedTimelineItem[] = [];
  const turns: ProjectedTurn[] = [];
  const turnMap = new Map<string, ProjectedTurn>();
  const toolMap = new Map<string, ProjectedToolCall>();
  const approvalMap = new Map<string, ApprovalRequest>();
  const diagnostics: DiagnosticEntry[] = [];

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
        status: 'running',
      };
      turnMap.set(key, turn);
      turns.push(turn);
      items.push(turn);
    }
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

  for (const ev of events) {
    const p = ev.payload;

    switch (ev.type) {
      case 'handoff.snapshot': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        (turn.handoffSnapshots ??= []).push({
          seq: ev.seq, driver: p.driver as ContextInjectionDriver, snapshotId: String(p.snapshotId ?? ''),
          sourceHarnesses: Array.isArray(p.sourceHarnesses) ? p.sourceHarnesses.filter((value): value is string => typeof value === 'string') : [],
          content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content, null, 2),
        });
        break;
      }
      case 'handoff.snapshot_delivered': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        const dispatched = turn.handoffSnapshots?.findLast((item) => item.snapshotId === p.snapshotId && item.driver === p.driver);
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
        turn.thinking += String(p.text ?? '');
        break;
      }

      case 'thinking.completed': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        if (typeof p.text === 'string' && p.text.length >= turn.thinking.length) {
          turn.thinking = p.text;
        }
        turn.thinkingDone = true;
        break;
      }

      case 'message.assistant.delta': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        turn.assistantText += String(p.text ?? '');
        break;
      }

      case 'message.assistant.completed': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        const finalText = String(p.text ?? '');
        if (finalText.length >= turn.assistantText.length) {
          turn.assistantText = finalText;
        }
        break;
      }

      case 'tool.call.started': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        const toolCallId = String(p.toolCallId ?? `tc_${ev.seq}`);
        let tool = toolMap.get(toolCallId);
        if (!tool) {
          tool = {
            toolCallId,
            toolName: String(p.toolName ?? 'Tool'),
            toolKind: (p.toolKind as ToolKind) ?? 'other',
            summary: String(p.summary ?? p.toolName ?? 'Tool call'),
            input: p.input ?? null,
            output: '',
            diff: '',
            status: 'running',
            startedAt: ev.createdAt,
          };
          toolMap.set(toolCallId, tool);
          turn.tools.push(tool);
        }
        break;
      }

      case 'tool.call.delta': {
        const toolCallId = String(p.toolCallId ?? '');
        const tool = toolMap.get(toolCallId);
        if (tool) {
          if (typeof p.outputDelta === 'string') tool.output += p.outputDelta;
          if (typeof p.diffDelta === 'string') tool.diff += p.diffDelta;
        }
        break;
      }

      case 'tool.call.completed': {
        const toolCallId = String(p.toolCallId ?? '');
        const tool = toolMap.get(toolCallId);
        if (tool) {
          const st = String(p.status ?? 'success');
          tool.status = st === 'error' ? 'error' : st === 'cancelled' ? 'cancelled' : 'success';
          if (typeof p.output === 'string' && p.output.length > 0) {
            tool.output = p.output;
          }
          if (typeof p.diff === 'string' && p.diff.length > 0) {
            tool.diff = p.diff;
          }
          tool.completedAt = ev.createdAt;
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
        }
        break;
      }

      case 'approval.resolved': {
        const approvalId = String(p.approvalId ?? '');
        const existing = approvalMap.get(approvalId);
        if (existing) {
          const decision = p.decision as ApprovalDecision;
          existing.decision = decision;
          existing.status = decision === 'deny' ? 'denied' : 'approved';
          existing.resolvedBy = (p.resolvedBy as 'desktop' | 'mobile' | 'auto') ?? 'desktop';
          existing.comment = typeof p.comment === 'string' ? p.comment : null;
          existing.resolvedAt = ev.createdAt;
        }
        break;
      }

      case 'turn.completed': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        turn.status = 'completed';
        turn.thinkingDone = true;
        break;
      }

      case 'turn.cancelled': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        turn.status = 'cancelled';
        turn.thinkingDone = true;
        break;
      }

      case 'turn.failed': {
        const turn = getOrCreateTurn(ev.turnId, ev.createdAt);
        applyTurnAttribution(turn, p);
        turn.status = 'failed';
        turn.errorMessage = String(p.message ?? 'Turn failed');
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

  const pendingApprovals = Array.from(approvalMap.values()).filter((a) => a.status === 'pending');

  return { items, turns, diagnostics, pendingApprovals };
}
