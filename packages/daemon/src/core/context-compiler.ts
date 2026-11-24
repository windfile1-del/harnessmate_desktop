import type {
  CanonicalEvent,
  ContextInjectionDriver,
  ContextPreview,
  ContextSyncMode,
  HarnessKind,
  Session,
  SessionHarnessBinding,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { getGitStatusSummary } from './git-service.js';
import type { TaskLedgerService } from './task-ledger-service.js';
import { composeSnapshot, type HandoffSnapshot } from './handoff-snapshot.js';
import type { PluginEvents } from '../plugin-host/runtime/events.js';
import { PluginApiError, type Disposer, type HandoffComposeEvent } from '@harnessmate/plugin-api';

import type { PortableHistoryMessage } from '../harnesses/types.js';

export type CodexInjectMessageItem = PortableHistoryMessage;

export interface CompiledContextPacket {
  preview: ContextPreview;
  snapshot: HandoffSnapshot;
  /** Full compiled context block (Block A + B + C + D) for ACP embeddedContext / Claude stdin / Envelope */
  deltaMarkdown: string;
  /** Vendor-neutral portable structured history items for drivers supporting native_items injection */
  portableItems: PortableHistoryMessage[];
  /** Objective text for drivers supporting native goal state */
  objective: string;
  /** Highest event seq covered by this compiled context */
  coveredUpToSeq: number;
  /** True when target harness needs context injection before executing the next turn */
  syncNeeded: boolean;
}

interface CompiledTurn {
  turnId: string;
  startSeq: number;
  endSeq: number;
  harnessId: string;
  model: string | null;
  userText: string;
  attachmentNotes: string[];
  tools: Array<{
    toolName: string;
    toolKind: string;
    summary: string;
    status: string;
    outputExcerpt: string;
    diffExcerpt: string;
  }>;
  assistantText: string;
  errorMessage: string | null;
}

export class ContextCompiler {
  private readonly sections = new Map<string, { source: string; order: number; text: string }>();

  constructor(
    private readonly store: HarnessMateStore,
    private readonly taskLedger: TaskLedgerService,
    readonly options: { budgetTokens: number; autoAttach: boolean },
    private readonly gitStatus: (cwd: string) => ReturnType<typeof getGitStatusSummary> | undefined,
    private readonly events: PluginEvents,
    private readonly collectIsolatedSections?: (event: HandoffComposeEvent) => Promise<Array<{ id: string; source: string; order: number; text: string }>>,
  ) {}

  registerSection(source: string, section: { id: string; order?: number; text: string }): Disposer {
    if (!/^[a-z0-9._-]{1,64}$/i.test(source) || !/^[a-z0-9._-]{1,48}$/i.test(section.id)) {
      throw new PluginApiError('E_INVALID_INPUT', '交接段落来源或 ID 无效');
    }
    const id = `${source}.${section.id}`;
    if (this.sections.has(id)) throw new PluginApiError('E_CONFLICT', `交接段落 ${id} 已注册`);
    if (this.sections.size >= 32 || section.text.length > 12_000) {
      throw new PluginApiError('E_LIMIT_EXCEEDED', '交接段落超出限制');
    }
    const registration = { source, order: section.order ?? 500, text: section.text };
    this.sections.set(id, registration);
    return () => { if (this.sections.get(id) === registration) this.sections.delete(id); };
  }

  /**
   * Compiles the exact incremental context packet required to bring
   * `targetHarnessId` up to date with `session` up to `upToSeq`.
   */
  async compile(opts: {
    session: Session;
    targetHarnessId: string;
    targetHarnessKind: HarnessKind;
    binding: SessionHarnessBinding | null;
    syncMode?: ContextSyncMode;
    excludeTurnId?: string;
    upToSeq?: number;
    budgetTokens?: number;
  }): Promise<CompiledContextPacket> {
    const { session, targetHarnessId, targetHarnessKind, binding } = opts;
    const referenceOnly = targetHarnessKind === 'agy' || targetHarnessKind === 'acp';
    const syncMode = opts.syncMode ?? session.contextSyncMode ?? 'auto';
    const budgetTokens = opts.budgetTokens ?? this.options.budgetTokens;
    const targetSeq = opts.upToSeq ?? session.lastSeq;

    const syncedUpToSeq =
      syncMode === 'full_ledger' ? 0 : Math.min(binding?.syncedUpToSeq ?? 0, targetSeq);
    const isWarmBinding = Boolean(syncedUpToSeq > 0);

    const rawEvents = this.store.iterateEvents(session.id, syncedUpToSeq, targetSeq);
    const turns = groupEventsIntoTurns(rawEvents, session.harnessId, opts.excludeTurnId);

    const unsyncedTurns = turns.filter((turn) => (turn.userText || turn.assistantText || turn.tools.length > 0) &&
      (!isWarmBinding || turn.harnessId !== targetHarnessId));
    const taskState = typeof (this.taskLedger as { getOrCreate?: unknown }).getOrCreate === 'function'
      ? this.taskLedger.getOrCreate(session)
      : await (async () => {
          const thirdParty = this.taskLedger as unknown as { get?: (sessionId: string) => Promise<Record<string, unknown> | null> };
          const remote = typeof thirdParty.get === 'function' ? await thirdParty.get(session.id) : null;
          return {
            sessionId: session.id,
            objective: typeof remote?.objective === 'string' ? remote.objective : '',
            steps: Array.isArray(remote?.steps) ? remote.steps : [],
            decisions: Array.isArray(remote?.decisions) ? remote.decisions : [],
            touchedFiles: Array.isArray(remote?.touchedFiles) ? remote.touchedFiles : [],
            verifications: [],
            blockers: Array.isArray(remote?.blockers) ? remote.blockers : [],
            pinnedFacts: Array.isArray(remote?.pinnedFacts) ? remote.pinnedFacts : [],
            rollingSummary: '',
            summarizedUpToSeq: 0,
            version: typeof remote?.version === 'number' ? remote.version : 1,
            ledgerFilePath: null,
            updatedAt: typeof remote?.updatedAt === 'number' ? remote.updatedAt : Date.now(),
          };
        })();
    const ledgerMarkdown = typeof (this.taskLedger as { renderLedgerMarkdown?: unknown }).renderLedgerMarkdown === 'function'
      ? this.taskLedger.renderLedgerMarkdown(taskState, session, referenceOnly ? 'reference' : 'directive')
      : [
          '## Task State Ledger',
          taskState.objective ? `- Objective: ${taskState.objective}` : '',
          taskState.decisions.length ? `- Decisions: ${taskState.decisions.join('; ')}` : '',
          taskState.blockers.length ? `- Blockers: ${taskState.blockers.join('; ')}` : '',
        ].filter(Boolean).join('\n');

    // Sync needed if there are un-synced turns OR a cold binding on a session with pre-seeded task ledger
    const hasLedgerFacts =
      Boolean(taskState.objective) ||
      taskState.pinnedFacts.length > 0 ||
      taskState.steps.length > 0 ||
      taskState.decisions.length > 0 ||
      taskState.blockers.length > 0;
    const needsHistory = unsyncedTurns.length > 0 || (!isWarmBinding && hasLedgerFacts && targetSeq > 1);

    // Block A: Live Workspace Truth Anchor
    const workspaceTruthBlock = await buildWorkspaceTruthBlock(session, taskState.ledgerFilePath, this.gitStatus);

    // Block B: Structured Task State Ledger
    const ledgerBlock = ledgerMarkdown.trim();

    // Allocate token budgets for Block C (Older Digest) and Block D (Verbatim Recent Window)
    const fixedTokens = estimateTokens(workspaceTruthBlock) + estimateTokens(ledgerBlock) + 320;
    const remainingBudget = Math.max(2000, budgetTokens - fixedTokens);
    const verbatimBudget = Math.floor(remainingBudget * 0.72);
    const digestBudget = Math.max(800, remainingBudget - verbatimBudget);

    // Pack Block D from newest turns backward until verbatimBudget is reached
    const verbatimTurns: CompiledTurn[] = [];
    let usedVerbatimTokens = 0;
    for (let i = unsyncedTurns.length - 1; i >= 0; i--) {
      const turn = unsyncedTurns[i]!;
      const rendered = renderTurnTranscript(turn, i + 1);
      const tTokens = estimateTokens(rendered);
      // Always include at least the most recent un-synced turn even if large
      if (verbatimTurns.length > 0 && usedVerbatimTokens + tTokens > verbatimBudget) {
        break;
      }
      verbatimTurns.unshift(turn);
      usedVerbatimTokens += tTokens;
    }

    const overflowCount = unsyncedTurns.length - verbatimTurns.length;
    const overflowTurns = overflowCount > 0 ? unsyncedTurns.slice(0, overflowCount) : [];

    // Block C: Rolling Episode Digest (for turns beyond verbatim window + saved rollingSummary)
    const digestParts: string[] = [];
    if (taskState.rollingSummary && !isWarmBinding) {
      digestParts.push(trimToTokenBudget(taskState.rollingSummary, Math.floor(digestBudget * 0.45)));
    }
    if (overflowTurns.length > 0) {
      const skeletonLines = overflowTurns.map((t, idx) => renderTurnSkeleton(t, idx + 1));
      digestParts.push(
        trimToTokenBudget(
          `### Compressed Earlier Un-Synced Turns (${overflowTurns.length} turns)\n${skeletonLines.join('\n')}`,
          Math.floor(digestBudget * 0.55),
        ),
      );
    }
    const digestBlock = digestParts.filter(Boolean).join('\n\n');

    // Block D: Verbatim Transcript Markdown
    const verbatimBlock =
      verbatimTurns.length > 0
        ? verbatimTurns
            .map((t, idx) => renderTurnTranscript(t, overflowCount + idx + 1))
            .join('\n\n---\n\n')
        : '';

    const renderedVerbatim = verbatimBlock
      ? `## ${isWarmBinding ? 'Incremental Transcript' : 'Recent Conversation Transcript'} (${verbatimTurns.length} turns)\n\n${verbatimBlock}`
      : '';
    const coreSections = [
      { id: 'workspace', source: 'git', text: referenceOnly ? trimMiddle(workspaceTruthBlock, 2_500) : workspaceTruthBlock },
      { id: 'ledger', source: 'ledger', text: referenceOnly ? trimMiddle(ledgerBlock, 5_000) : ledgerBlock },
      { id: 'digest', source: 'conversation', text: digestBlock ? `## Earlier Context Digest\n\n${digestBlock}` : '' },
      { id: 'transcript', source: 'conversation', text: renderedVerbatim },
    ];
    if (referenceOnly) {
      coreSections[2]!.text = trimMiddle(coreSections[2]!.text, 2_500);
      coreSections[3]!.text = trimMiddle(coreSections[3]!.text, 10_500);
    }
    const extraSections: typeof coreSections = [];
    let remainingChars = referenceOnly ? 2_500 : Math.min(8_000, budgetTokens);
    const isolatedSections = this.collectIsolatedSections
      ? await this.collectIsolatedSections({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          targetHarnessId,
          targetHarnessKind,
          referenceOnly,
        })
      : [];
    const registrations: Array<[string, { source: string; order: number; text: string }]> = [
      ...this.sections.entries(),
      ...isolatedSections.map((sec): [string, { source: string; order: number; text: string }] => [
        sec.id,
        { source: sec.source, order: sec.order, text: sec.text },
      ]),
    ].sort(([, first], [, second]) => first.order - second.order);
    this.events.waterfall('handoff.compose', Object.freeze({ append: (id: string, source: string, text: string) => {
      if (remainingChars < 200 || !text.trim()) return;
      const formatted = `## ${id}\n\n${trimMiddle(text, Math.min(remainingChars - 120, 2_000))}`;
      extraSections.push({ id, source, text: formatted });
      remainingChars -= formatted.length;
    } }), registrations.map(([id, { source, text }]) => (value, next) => { value.append(id, source, text); next(); }));
    const sectionText = [...coreSections, ...extraSections];
    const previous = referenceOnly && syncMode !== 'full_ledger' && binding?.nativeSessionId
      ? this.store.getLastHandoffReceipt(session.id, targetHarnessId, binding.nativeSessionId)
      : undefined;
    const snapshot = composeSnapshot(sectionText, previous);
    const ignored = new Set(['digest', 'transcript']);
    const removed = previous ? Object.keys(previous.sectionHashes)
      .filter((id) => !ignored.has(id) && snapshot.sectionHashes[id] === undefined) : [];
    const syncNeeded = needsHistory || Boolean(previous &&
      (removed.length || snapshot.sections.some(({ id }) => !ignored.has(id))));
    const driverPlanned = selectPlannedDriver(targetHarnessKind, isWarmBinding, syncNeeded);
    const sections: string[] = [
      `<harnessmate_context_sync version="1" snapshot="${snapshot.snapshotId}" session_id="${session.id}" target_harness="${targetHarnessId}" mode="${isWarmBinding ? 'incremental_delta' : 'initial_sync'}" synced_from_seq="${syncedUpToSeq}" synced_to_seq="${targetSeq}" unsynced_turns="${unsyncedTurns.length}">`,
      referenceOnly ? '## Previous Workspace Activity' : '## Continuity Protocol',
      referenceOnly
        ? 'The following records describe previous conversations and task activity in this workspace.'
        : isWarmBinding
        ? `You (${targetHarnessId}) previously participated in this session up to event #${syncedUpToSeq}. Below is ONLY the incremental progress completed by other harnesses since then, plus the latest Workspace Truth & Task State Ledger. Continue seamlessly without asking the user to repeat prior context.`
        : `You (${targetHarnessId}) are taking over an active unified session. Previous turns were executed by other harnesses on this exact workspace. Continue seamlessly from the Task State Ledger and transcript below without asking the user to repeat prior context.`,
    ];
    if (snapshot.previousSnapshotId) {
      const unchanged = sectionText.filter(({ id }) => snapshot.sectionHashes[id] && !snapshot.sections.some((section) => section.id === id));
      if (unchanged.length) sections.push('', `Unchanged sections (${unchanged.map(({ id }) => id).join(', ')}) match snapshot ${snapshot.previousSnapshotId}.`);
      if (removed.length) sections.push('', `Sections removed since the previous snapshot: ${removed.join(', ')}.`);
    }
    for (const section of snapshot.sections) sections.push('', section.text);
    sections.push('</harnessmate_context_sync>');
    const deltaMarkdown = sections.join('\n');

    // Assemble vendor-neutral portable structured message items for native_items injection
    const portableItems: PortableHistoryMessage[] = [];
    if (syncNeeded) {
      // Inject Workspace Truth + Task Ledger (+ older digest if any) as a compact anchor pair
      const anchorParts = [
        '[HarnessMate Context Sync — Shared Task State & Workspace Truth]',
        workspaceTruthBlock,
        ledgerBlock,
      ];
      if (digestBlock) {
        anchorParts.push('## Earlier Un-Synced Turns Digest', digestBlock);
      }
      anchorParts.push(...extraSections.map(({ text }) => text));
      portableItems.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: anchorParts.join('\n\n') }],
      });
      portableItems.push({
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: `Acknowledged. I have synced the HarnessMate Task State Ledger (v${taskState.version}) and workspace state through event #${targetSeq}.`,
          },
        ],
      });

      // Inject each verbatim un-synced turn as real user/assistant structured message items
      for (const turn of verbatimTurns) {
        if (turn.userText || turn.attachmentNotes.length > 0) {
          const userBody = [
            turn.userText,
            turn.attachmentNotes.length > 0
              ? `\n[Attachments: ${turn.attachmentNotes.join(', ')}]`
              : '',
          ]
            .filter(Boolean)
            .join('');
          portableItems.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: userBody }],
          });
        }

        const assistantBody = renderAssistantWithToolsForInject(turn);
        if (assistantBody) {
          portableItems.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: assistantBody }],
          });
        }
      }
    }

    const estimatedTokens = syncNeeded ? estimateTokens(deltaMarkdown) : 0;

    const preview: ContextPreview = {
      sessionId: session.id,
      targetHarnessId,
      targetHarnessKind,
      syncedUpToSeq,
      currentLastSeq: targetSeq,
      unsyncedTurnCount: unsyncedTurns.length,
      estimatedTokens,
      budgetTokens,
      driverPlanned,
      isWarmBinding,
      syncNeeded,
      compiledMarkdown: syncNeeded ? deltaMarkdown : '(目标引擎已是最新上下文，无需额外注入)',
      ledgerMarkdown,
      deltaTurnSummary: unsyncedTurns.map((t) => ({
        turnId: t.turnId,
        harnessId: t.harnessId,
        model: t.model,
        userPreview: compactOneLine(t.userText || '(Tool / continuation turn)', 96),
      })),
    };

    return {
      preview,
      snapshot,
      deltaMarkdown,
      portableItems,
      objective: taskState.objective || session.title,
      coveredUpToSeq: targetSeq,
      syncNeeded,
    };
  }
}

function selectPlannedDriver(
  kind: HarnessKind,
  isWarmBinding: boolean,
  syncNeeded: boolean,
): ContextInjectionDriver {
  if (!syncNeeded && isWarmBinding) return 'native_warm';
  if (kind === 'codex') return 'codex_inject_items';
  if (kind === 'agy' || kind === 'acp') return 'acp_embedded_context';
  if (kind === 'claude') return 'claude_sysfile_delta';
  return 'prompt_envelope';
}

async function buildWorkspaceTruthBlock(
  session: Session,
  ledgerFilePath: string | null | undefined,
  gitStatus: (cwd: string) => ReturnType<typeof getGitStatusSummary> | undefined,
): Promise<string> {
  const lines: string[] = [
    '## Workspace Truth Anchor (Live)',
    `- **Working Directory**: \`${session.cwd}\``,
  ];
  if (session.worktreeBranch) {
    lines.push(`- **Worktree Branch**: \`${session.worktreeBranch}\``);
  }
  if (ledgerFilePath) {
    lines.push(`- **Synced Ledger File**: \`${ledgerFilePath}\``);
  }
  try {
    const git = await gitStatus(session.cwd);
    if (git?.isGitRepo) {
      lines.push(`- **Git Branch**: \`${git.branch || 'detached'}\` (ahead ${git.ahead}, behind ${git.behind})`);
      const relevantChanges = git.changes.filter((c) => !c.path.startsWith('.harnessmate/'));
      if (relevantChanges.length > 0) {
        lines.push(`- **Uncommitted Changes (${relevantChanges.length} files)**:`);
        for (const c of relevantChanges.slice(0, 18)) {
          lines.push(`  - \`${c.status}\` ${c.path}`);
        }
        if (relevantChanges.length > 18) {
          lines.push(`  - ... (+${relevantChanges.length - 18} more files)`);
        }
      } else {
        lines.push('- **Uncommitted Changes**: Working tree clean');
      }
    }
  } catch {
    // non-git or git unavailable
  }
  return lines.join('\n');
}

function groupEventsIntoTurns(
  events: Iterable<CanonicalEvent>,
  fallbackHarnessId: string,
  excludeTurnId?: string,
): CompiledTurn[] {
  const order: string[] = [];
  const map = new Map<string, CompiledTurn>();
  const toolIdxMap = new Map<string, { turn: CompiledTurn; idx: number }>();

  const ensureTurn = (turnId: string, seq: number, harnessId?: string): CompiledTurn => {
    let t = map.get(turnId);
    if (!t) {
      t = {
        turnId,
        startSeq: seq,
        endSeq: seq,
        harnessId: harnessId || fallbackHarnessId,
        model: null,
        userText: '',
        attachmentNotes: [],
        tools: [],
        assistantText: '',
        errorMessage: null,
      };
      map.set(turnId, t);
      order.push(turnId);
    }
    t.endSeq = Math.max(t.endSeq, seq);
    if (harnessId) t.harnessId = harnessId;
    return t;
  };

  for (const ev of events) {
    if (!ev.turnId || ev.payload.maintenance === true) continue;
    if (excludeTurnId && ev.turnId === excludeTurnId) continue;
    const p = ev.payload;
    const evHarness = typeof p.harnessId === 'string' && p.harnessId ? p.harnessId : undefined;
    const turn = ensureTurn(ev.turnId, ev.seq, evHarness);

    if (typeof p.actualModel === 'string' && p.actualModel) {
      turn.model = p.actualModel;
    } else if (typeof p.model === 'string' && p.model && !turn.model) {
      turn.model = p.model;
    }

    switch (ev.type) {
      case 'message.user': {
        turn.userText = String(p.text ?? '');
        if (Array.isArray(p.attachments)) {
          for (const a of p.attachments as Array<{ name?: string; relativePath?: string; kind?: string }>) {
            const label = a.relativePath || a.name;
            if (label) turn.attachmentNotes.push(`${a.kind === 'image' ? 'img:' : '@'}${label}`);
          }
        }
        break;
      }
      case 'message.assistant.delta': {
        turn.assistantText += String(p.text ?? '');
        break;
      }
      case 'message.assistant.completed': {
        const full = String(p.text ?? '');
        if (full.length >= turn.assistantText.length) turn.assistantText = full;
        break;
      }
      case 'tool.call.started': {
        const callId = String(p.toolCallId ?? `tool_${turn.tools.length}`);
        const idx = turn.tools.length;
        turn.tools.push({
          toolName: String(p.toolName ?? 'tool'),
          toolKind: String(p.toolKind ?? 'other'),
          summary: String(p.summary ?? ''),
          status: 'running',
          outputExcerpt: '',
          diffExcerpt: '',
        });
        toolIdxMap.set(callId, { turn, idx });
        break;
      }
      case 'tool.call.completed': {
        const callId = String(p.toolCallId ?? '');
        const hit = toolIdxMap.get(callId);
        if (hit) {
          const item = hit.turn.tools[hit.idx]!;
          item.status = String(p.status ?? 'success');
          item.outputExcerpt = trimMiddle(String(p.output ?? ''), 900);
          item.diffExcerpt = trimMiddle(String(p.diff ?? ''), 1200);
        } else {
          turn.tools.push({
            toolName: String(p.toolName ?? 'tool'),
            toolKind: 'other',
            summary: '',
            status: String(p.status ?? 'success'),
            outputExcerpt: trimMiddle(String(p.output ?? ''), 900),
            diffExcerpt: trimMiddle(String(p.diff ?? ''), 1200),
          });
        }
        break;
      }
      case 'turn.failed': {
        turn.errorMessage = String(p.message ?? 'Turn failed');
        break;
      }
      default:
        break;
    }
  }

  return order.map((id) => map.get(id)!);
}

function renderTurnTranscript(turn: CompiledTurn, index: number): string {
  const actor = turn.model ? `${turn.harnessId} · ${turn.model}` : turn.harnessId;
  const parts: string[] = [`### Turn ${index} [${actor}]`];

  if (turn.userText) {
    const attach =
      turn.attachmentNotes.length > 0 ? ` _(Attachments: ${turn.attachmentNotes.join(', ')})_` : '';
    parts.push(`**User**: ${trimMiddle(turn.userText, 2400)}${attach}`);
  }

  if (turn.tools.length > 0) {
    const toolLines: string[] = ['**Tools Executed**:'];
    for (const tc of turn.tools.slice(0, 10)) {
      const desc = tc.summary ? ` — ${compactOneLine(tc.summary, 140)}` : '';
      toolLines.push(`- \`${tc.toolName}\` [${tc.status}]${desc}`);
      if (tc.diffExcerpt) {
        toolLines.push('  ```diff', indentLines(tc.diffExcerpt, '  '), '  ```');
      } else if (tc.outputExcerpt && (tc.status === 'error' || tc.toolKind === 'shell')) {
        toolLines.push(`  > Output: ${compactOneLine(tc.outputExcerpt, 320)}`);
      }
    }
    if (turn.tools.length > 10) {
      toolLines.push(`- ... (+${turn.tools.length - 10} more tool calls)`);
    }
    parts.push(toolLines.join('\n'));
  }

  if (turn.assistantText) {
    parts.push(`**Assistant (${actor})**:\n${trimMiddle(turn.assistantText, 3600)}`);
  }

  if (turn.errorMessage) {
    parts.push(`**Turn Error**: ${compactOneLine(turn.errorMessage, 320)}`);
  }

  return parts.join('\n\n');
}

function renderAssistantWithToolsForInject(turn: CompiledTurn): string {
  const actor = turn.model ? `${turn.harnessId} · ${turn.model}` : turn.harnessId;
  const parts: string[] = [`[Executed previously by ${actor}]`];

  if (turn.tools.length > 0) {
    const summaryLines = turn.tools.slice(0, 8).map((tc) => {
      const out = tc.outputExcerpt && tc.status === 'error' ? ` | err: ${compactOneLine(tc.outputExcerpt, 160)}` : '';
      return `- ${tc.toolName} (${tc.status}): ${compactOneLine(tc.summary, 120)}${out}`;
    });
    parts.push(`Tools used:\n${summaryLines.join('\n')}`);
  }

  if (turn.assistantText) {
    parts.push(trimMiddle(turn.assistantText, 3600));
  } else if (turn.errorMessage) {
    parts.push(`Turn failed with error: ${compactOneLine(turn.errorMessage, 300)}`);
  }

  return parts.length > 1 ? parts.join('\n\n') : '';
}

function renderTurnSkeleton(turn: CompiledTurn, index: number): string {
  const actor = turn.model ? `${turn.harnessId}/${turn.model}` : turn.harnessId;
  const tools =
    turn.tools.length > 0
      ? ` | Tools: ${turn.tools
          .slice(0, 5)
          .map((t) => `${t.toolName}:${t.status}`)
          .join(', ')}`
      : '';
  const outcome = turn.errorMessage
    ? `ERROR: ${compactOneLine(turn.errorMessage, 120)}`
    : compactOneLine(turn.assistantText, 220) || '(no text)';
  return `- **Turn ${index} [${actor}]** User: "${compactOneLine(turn.userText, 120)}"${tools} → ${outcome}`;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.65 + other * 0.28);
}

function trimToTokenBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const approxChars = Math.max(200, Math.floor(maxTokens * 2.5));
  return `${text.slice(0, approxChars)}\n... [truncated to fit context budget]`;
}

function trimMiddle(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.floor(maxChars * 0.28);
  return `${trimmed.slice(0, head)}\n... [${trimmed.length - head - tail} chars omitted] ...\n${trimmed.slice(-tail)}`;
}

function compactOneLine(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

function indentLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n');
}
