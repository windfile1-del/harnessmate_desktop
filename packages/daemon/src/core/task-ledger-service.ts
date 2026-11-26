import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CanonicalEvent,
  Session,
  SessionTaskState,
  TaskFailedAttempt,
  TaskStep,
  TaskVerification,
  UpdateTaskStateRequest,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { getGitStatusSummary } from './git-service.js';

const VERIFICATION_CMD_RE =
  /\b(vitest|jest|pytest|mocha|phpunit|rspec|tsc|eslint|biome|gradle|gradlew)\b|\b(cargo\s+(?:test|check|build|clippy)|go\s+(?:test|vet|build))\b|\b((?:pnpm|npm|yarn|bun)\s+(?:-\S+(?:\s+(?:"[^"]*"|'[^']*'|[^-\s]\S*))?\s+|run\s+)*(?:\S*:)?(?:test|build|typecheck|lint|check)|npm\s+t)\b|\b(make|cmake|ninja|msbuild|dotnet)\s+(?:test|build|check)\b/i;

const MAX_FAILED_ATTEMPTS = 12;
const TRANSIENT_FAILURE_RE =
  /\b(429|rate.?limit|quota|too many requests|unauthorized|auth_required|timed?\s*out|econnreset)\b/i;

const READ_ONLY_EXECUTABLES = new Set([
  'ls',
  'll',
  'la',
  'dir',
  'cat',
  'bat',
  'type',
  'pwd',
  'cd',
  'pushd',
  'popd',
  'set-location',
  'get-location',
  'get-childitem',
  'get-content',
  'select-string',
  'head',
  'tail',
  'less',
  'more',
  'echo',
  'printf',
  'write-output',
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ag',
  'ack',
  'find',
  'fd',
  'tree',
  'stat',
  'wc',
  'file',
  'which',
  'where',
  'whereis',
  'command',
  'whoami',
  'id',
  'uname',
  'date',
  'env',
  'printenv',
  'ps',
  'du',
  'df',
  'realpath',
  'readlink',
  'dirname',
  'basename',
]);

interface WorkspaceLedgerMeta {
  activeSessionId: string;
  lastWrittenHash: string;
  lastSnapshot: {
    objective: string;
    pinnedFacts: string[];
    decisions: string[];
    blockers: string[];
  };
  updatedAt: number;
}

export class TaskLedgerService {
  constructor(private readonly store: HarnessMateStore,
    private readonly gitStatus: (cwd: string, session: Session) => Promise<Awaited<ReturnType<typeof getGitStatusSummary>> | undefined> | undefined,
    private readonly instanceId = 'core.task-ledger') {}

  private get usesLegacyData(): boolean {
    return this.instanceId === 'core.task-ledger';
  }

  private persist(state: SessionTaskState): SessionTaskState {
    if (this.usesLegacyData) return this.store.upsertTaskState(state);
    this.store.setPluginStorageValue(state.sessionId, this.instanceId, 'task-state', state);
    return state;
  }

  syncSession(session: Session): void {
    const state = this.getOrCreate(session);
    const { ledgerFilePath, state: mergedState, conflictDetected } = this.syncWorkspaceLedgerWithMerge(session, state);
    if (conflictDetected || (ledgerFilePath && ledgerFilePath !== state.ledgerFilePath)) {
      this.persist({
        ...mergedState,
        ...(ledgerFilePath ? { ledgerFilePath } : {}),
        ...(conflictDetected ? { version: state.version + 1, updatedAt: Date.now() } : {}),
      });
    }
  }

  getOrCreate(session: Session): SessionTaskState {
    const existing = this.usesLegacyData
      ? this.store.getTaskState(session.id)
      : this.store.getPluginStorageValue(session.id, this.instanceId, 'task-state') as SessionTaskState | undefined;
    if (existing) return existing;
    return this.persist({
      sessionId: session.id,
      objective: '',
      steps: [],
      decisions: [],
      touchedFiles: [],
      verifications: [],
      blockers: [],
      pinnedFacts: [],
      rollingSummary: '',
      summarizedUpToSeq: 0,
      version: 1,
      ledgerFilePath: null,
      updatedAt: Date.now(),
    });
  }

  updateManual(
    session: Session,
    patch: UpdateTaskStateRequest & { failedAttempts?: TaskFailedAttempt[] },
  ): SessionTaskState {
    const current = this.getOrCreate(session);
    let nextFailedAttempts = current.failedAttempts;
    if (patch.failedAttempts !== undefined) {
      const normalized = patch.failedAttempts
        .map((fa) => normalizeFailedAttempt(fa, session.harnessId, session.cwd))
        .filter((fa): fa is TaskFailedAttempt => fa !== null);
      nextFailedAttempts = mergeFailedAttempts([], normalized);
    }

    const next: SessionTaskState = {
      ...current,
      objective: patch.objective !== undefined ? patch.objective.trim() : current.objective,
      steps: patch.steps !== undefined ? patch.steps : current.steps,
      decisions: patch.decisions !== undefined ? dedupeStrings(patch.decisions) : current.decisions,
      touchedFiles:
        patch.touchedFiles !== undefined ? dedupeStrings(patch.touchedFiles) : current.touchedFiles,
      verifications:
        patch.verifications !== undefined ? patch.verifications.slice(-20) : current.verifications,
      blockers: patch.blockers !== undefined ? dedupeStrings(patch.blockers) : current.blockers,
      pinnedFacts:
        patch.pinnedFacts !== undefined ? dedupeStrings(patch.pinnedFacts) : current.pinnedFacts,
      ...(nextFailedAttempts && nextFailedAttempts.length > 0 ? { failedAttempts: nextFailedAttempts } : {}),
      rollingSummary:
        patch.rollingSummary !== undefined ? patch.rollingSummary.trim() : current.rollingSummary,
      version: current.version + 1,
      updatedAt: Date.now(),
    };

    const { ledgerFilePath, state: mergedState } = this.syncWorkspaceLedgerWithMerge(session, next);
    if (ledgerFilePath) {
      mergedState.ledgerFilePath = ledgerFilePath;
    }
    return this.persist(mergedState);
  }

  recordFailedAttempt(
    session: Session,
    attempt: {
      id?: string;
      summary: string;
      failureReason: string;
      relatedFiles?: string[];
      harnessInstanceId?: string | null;
      recordedAt?: number;
    },
  ): SessionTaskState {
    const current = this.getOrCreate(session);
    const normalized = normalizeFailedAttempt(attempt, session.harnessId, session.cwd);
    if (!normalized) return current;

    const mergedAttempts = mergeFailedAttempts(current.failedAttempts ?? [], [normalized]);
    const next: SessionTaskState = {
      ...current,
      failedAttempts: mergedAttempts,
      version: current.version + 1,
      updatedAt: Date.now(),
    };

    const { ledgerFilePath, state: mergedState } = this.syncWorkspaceLedgerWithMerge(session, next);
    if (ledgerFilePath) {
      mergedState.ledgerFilePath = ledgerFilePath;
    }
    return this.persist(mergedState);
  }

  /**
   * Deterministically extracts task state updates from a completed/failed turn
   * plus real workspace git status — zero extra LLM calls, zero added latency.
   */
  async ingestTurnEvents(
    session: Session,
    turnId: string,
    turnHarnessId: string,
    turnEvents: CanonicalEvent[],
  ): Promise<SessionTaskState> {
    const git = await this.readGitChanges(session);
    return this.applyTurnEvents(session, turnId, turnHarnessId, turnEvents, git);
  }

  async readGitChanges(session: Session): Promise<string[]> {
    try {
      const git = hasGitRepoAncestor(session.cwd) ? await this.gitStatus(session.cwd, session) : undefined;
      return git?.isGitRepo
        ? git.changes.map((change) => change.path).filter((file) => file && !file.startsWith('.harnessmate/'))
        : [];
    } catch {
      return [];
    }
  }

  applyTurnEvents(
    session: Session,
    turnId: string,
    turnHarnessId: string,
    turnEvents: CanonicalEvent[],
    gitChanges: readonly string[],
    mirror = true,
  ): SessionTaskState {
    if (!this.store.isOpen()) {
      return {
        sessionId: session.id,
        objective: session.title,
        steps: [],
        decisions: [],
        touchedFiles: [],
        verifications: [],
        blockers: [],
        pinnedFacts: [],
        rollingSummary: '',
        summarizedUpToSeq: 0,
        version: 1,
        ledgerFilePath: null,
        updatedAt: Date.now(),
      };
    }
    const current = this.getOrCreate(session);
    let objective = current.objective;
    const steps = [...current.steps];
    const decisions = [...current.decisions];
    const touchedFiles = new Set<string>(current.touchedFiles);
    const verifications = [...current.verifications];
    const blockers = [...current.blockers];
    const incomingFailedAttempts: TaskFailedAttempt[] = [];
    const turnTouchedFiles = new Set<string>();
    let recordedTurnToolFailure = false;

    let userText = '';
    let assistantText = '';
    let turnFailedMessage = '';

    for (const ev of turnEvents) {
      if (ev.turnId && ev.turnId !== turnId) continue;
      const p = ev.payload;

      if (ev.type === 'message.user') {
        userText = String(p.text ?? '').trim();
        if (!objective && userText) {
          objective = userText.replace(/\s+/g, ' ').slice(0, 280);
        }
      } else if (ev.type === 'message.assistant.delta') {
        assistantText += String(p.text ?? '');
      } else if (ev.type === 'message.assistant.completed') {
        const full = String(p.text ?? '');
        if (full.length >= assistantText.length) assistantText = full;
      } else if (ev.type === 'tool.call.started') {
        const toolKind = String(p.toolKind ?? 'other');
        const toolName = String(p.toolName ?? '');
        const summary = String(p.summary ?? '');
        const extracted = extractFilePathsFromTool(toolKind, toolName, summary, p.input, session.cwd);
        for (const f of extracted) {
          touchedFiles.add(f);
          turnTouchedFiles.add(f);
        }
      } else if (ev.type === 'tool.call.completed') {
        const toolName = String(p.toolName ?? '');
        const status = String(p.status ?? 'success');
        const output = String(p.output ?? '');
        const diff = String(p.diff ?? '');

        const diffFiles = extractFilePathsFromDiff(diff);
        for (const f of diffFiles) {
          touchedFiles.add(f);
          turnTouchedFiles.add(f);
        }

        const matchingStart = turnEvents.find(
          (e) => e.type === 'tool.call.started' && e.payload.toolCallId === p.toolCallId,
        );
        const cmdCandidate =
          extractShellCommand(matchingStart?.payload.input, String(matchingStart?.payload.summary ?? '')) ||
          toolName;

        const isShellTool = matchingStart?.payload.toolKind === 'shell';
        const isReadOnly = isShellTool && isAllReadOnlyShellCommand(cmdCandidate);

        if (isVerificationCommand(matchingStart, cmdCandidate)) {
          const normalizedCmd = compactSingleLine(cmdCandidate, 160);
          const isFailStatus = status === 'error' || status === 'failed';
          upsertVerification(verifications, {
            command: normalizedCmd,
            status: status === 'success' ? 'pass' : isFailStatus ? 'fail' : 'unknown',
            summary: compactSingleLine(output, 180) || (status === 'success' ? 'Exit 0' : 'Failed'),
            harnessId: turnHarnessId,
            timestamp: ev.createdAt,
          });
          if (isFailStatus) {
            const failLine = `验证失败 (${normalizedCmd.slice(0, 80)}): ${compactSingleLine(output, 140) || '命令报错'}`;
            if (!blockers.includes(failLine)) blockers.push(failLine);
          } else if (status === 'success') {
            const cmdKey = normalizedCmd.slice(0, 40);
            for (let i = blockers.length - 1; i >= 0; i--) {
              if (blockers[i]!.includes(cmdKey)) {
                blockers.splice(i, 1);
              }
            }
          }
        }

        if ((status === 'error' || status === 'failed') && !isReadOnly) {
          const startFiles = matchingStart
            ? extractFilePathsFromTool(
                String(matchingStart.payload.toolKind ?? 'other'),
                String(matchingStart.payload.toolName ?? ''),
                String(matchingStart.payload.summary ?? ''),
                matchingStart.payload.input,
                session.cwd,
              )
            : [];
          const relatedFiles = [...new Set([...diffFiles, ...startFiles])];
          const attemptSummary = isShellTool
            ? `Shell command \`${compactSingleLine(cmdCandidate, 180)}\` failed`
            : `Tool \`${toolName || 'tool'}\` (${compactSingleLine(String(matchingStart?.payload.summary ?? toolName), 160)}) failed`;
          const attempt = normalizeFailedAttempt(
            {
              summary: attemptSummary,
              failureReason: compactSingleLine(output, 480) || 'Exited with error',
              relatedFiles,
              harnessInstanceId: turnHarnessId,
              recordedAt: ev.createdAt,
            },
            turnHarnessId,
            session.cwd,
          );
          if (attempt) {
            incomingFailedAttempts.push(attempt);
            recordedTurnToolFailure = true;
          }
        }
      } else if (ev.type === 'turn.failed') {
        turnFailedMessage = String(p.message ?? '').trim();
      }
    }

    for (const file of gitChanges) touchedFiles.add(file);

    // Extract markdown checklist steps from assistant reply
    if (assistantText) {
      mergeMarkdownSteps(steps, assistantText, turnHarnessId);
    }

    if (turnFailedMessage) {
      const b = `[${turnHarnessId}] 轮次中断: ${compactSingleLine(turnFailedMessage, 160)}`;
      if (!blockers.includes(b)) blockers.push(b);

      if (!TRANSIENT_FAILURE_RE.test(turnFailedMessage) && !recordedTurnToolFailure) {
        const attempt = normalizeFailedAttempt(
          {
            summary: compactSingleLine(userText || assistantText || 'Turn execution failed', 280),
            failureReason: compactSingleLine(turnFailedMessage, 480),
            relatedFiles: [...turnTouchedFiles],
            harnessInstanceId: turnHarnessId,
            recordedAt: turnEvents.at(-1)?.createdAt ?? Date.now(),
          },
          turnHarnessId,
          session.cwd,
        );
        if (attempt) {
          incomingFailedAttempts.push(attempt);
        }
      }
    }

    const mergedFailedAttempts = mergeFailedAttempts(
      current.failedAttempts ?? [],
      incomingFailedAttempts,
    );

    const next: SessionTaskState = {
      ...current,
      objective: objective || session.title,
      steps: steps.slice(-24),
      decisions: dedupeStrings(decisions).slice(-20),
      touchedFiles: Array.from(touchedFiles).slice(-40),
      verifications: verifications.slice(-12),
      blockers: dedupeStrings(blockers).slice(-12),
      pinnedFacts: current.pinnedFacts,
      ...(mergedFailedAttempts.length > 0 ? { failedAttempts: mergedFailedAttempts } : {}),
      rollingSummary: current.rollingSummary,
      summarizedUpToSeq: current.summarizedUpToSeq,
      version: current.version + 1,
      updatedAt: Date.now(),
    };

    if (!this.store.isOpen()) return next;
    if (!mirror) return this.persist(next);
    const { ledgerFilePath, state: mergedState } = this.syncWorkspaceLedgerWithMerge(session, next);
    if (ledgerFilePath) {
      mergedState.ledgerFilePath = ledgerFilePath;
    }

    if (!this.store.isOpen()) {
      return mergedState;
    }
    return this.persist(mergedState);
  }

  /**
   * Builds a deterministic high-signal rolling digest of the session history
   * on user demand (zero extra LLM latency/cost).
   */
  generateDeterministicDigest(session: Session): SessionTaskState {
    const current = this.getOrCreate(session);
    const events = this.store.iterateEvents(session.id, 0, session.lastSeq);
    const lines: string[] = [];
    let turnNum = 0;

    const turnOrder: string[] = [];
    const byTurn = new Map<string, CanonicalEvent[]>();
    for (const ev of events) {
      if (!ev.turnId || ev.payload.maintenance === true) continue;
      if (!byTurn.has(ev.turnId)) {
        byTurn.set(ev.turnId, []);
        turnOrder.push(ev.turnId);
      }
      byTurn.get(ev.turnId)!.push(ev);
    }

    for (const tid of turnOrder) {
      const evs = byTurn.get(tid)!;
      let userText = '';
      let assistantText = '';
      let harnessId = session.harnessId;
      let model = '';
      const tools: string[] = [];
      let failed = '';

      for (const e of evs) {
        if (typeof e.payload.harnessId === 'string') harnessId = e.payload.harnessId;
        if (typeof e.payload.actualModel === 'string' && e.payload.actualModel) {
          model = e.payload.actualModel;
        } else if (typeof e.payload.model === 'string' && e.payload.model && !model) {
          model = e.payload.model;
        }

        if (e.type === 'message.user') userText = String(e.payload.text ?? '');
        else if (e.type === 'message.assistant.delta') assistantText += String(e.payload.text ?? '');
        else if (e.type === 'message.assistant.completed') {
          const t = String(e.payload.text ?? '');
          if (t.length >= assistantText.length) assistantText = t;
        } else if (e.type === 'tool.call.completed') {
          tools.push(`${String(e.payload.toolName ?? 'tool')}:${String(e.payload.status ?? 'ok')}`);
        } else if (e.type === 'turn.failed') {
          failed = String(e.payload.message ?? '');
        }
      }
      if (!userText && !assistantText) continue;
      turnNum += 1;
      const actor = model ? `${harnessId}/${model}` : harnessId;
      const toolPart = tools.length > 0 ? ` | 工具: ${tools.slice(0, 6).join(', ')}` : '';
      const outcome = failed
        ? `失败: ${compactSingleLine(failed, 120)}`
        : compactSingleLine(assistantText, 240) || '(无文本输出)';
      lines.push(
        `- **Turn ${turnNum} [${actor}]** 用户: ${compactSingleLine(userText, 140)}${toolPart} → 结论: ${outcome}`,
      );
    }

    const digest = lines.slice(-24).join('\n');
    const next: SessionTaskState = {
      ...current,
      rollingSummary: digest,
      summarizedUpToSeq: session.lastSeq,
      version: current.version + 1,
      updatedAt: Date.now(),
    };
    const { ledgerFilePath, state: mergedState } = this.syncWorkspaceLedgerWithMerge(session, next);
    if (ledgerFilePath) mergedState.ledgerFilePath = ledgerFilePath;
    return this.persist(mergedState);
  }

  /**
   * Renders the Task State Ledger into crisp, structured Markdown suitable both
   * for injection into any Harness and for `<cwd>/.harnessmate/task-ledger.md`.
   */
  renderLedgerMarkdown(state: SessionTaskState, session: Session, style: 'directive' | 'reference' = 'directive'): string {
    return renderTaskLedgerMarkdown(state, session, style);
  }

  /**
   * Mirrors the Task Ledger to `<cwd>/.harnessmate/task-ledger.md` and
   * `<cwd>/.harnessmate/sessions/<sessionId>.md` using atomic rename writes.
   */
  syncWorkspaceLedgerFile(session: Session, state: SessionTaskState): string | null {
    return this.syncWorkspaceLedgerWithMerge(session, state).ledgerFilePath;
  }

  private syncWorkspaceLedgerWithMerge(
    session: Session,
    state: SessionTaskState,
  ): { ledgerFilePath: string | null; state: SessionTaskState; conflictDetected: boolean } {
    try {
      if (!this.usesLegacyData || !session.cwd || !fs.existsSync(session.cwd)) {
        return { ledgerFilePath: null, state, conflictDetected: false };
      }
      const hmDir = path.join(session.cwd, '.harnessmate');
      const sessionsDir = path.join(hmDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const activeLedgerPath = path.join(hmDir, 'task-ledger.md');
      const sessionLedgerPath = path.join(sessionsDir, `${session.id}.md`);
      const metaPath = path.join(hmDir, '.task-ledger-meta.json');

      const meta = readWorkspaceLedgerMeta(metaPath);
      const diskContent = fs.existsSync(activeLedgerPath) ? fs.readFileSync(activeLedgerPath, 'utf8') : null;
      const diskHash = diskContent !== null ? sha256Hex(diskContent) : null;

      const isSameSessionConflict = Boolean(
        diskContent !== null &&
          meta &&
          meta.activeSessionId === session.id &&
          meta.lastWrittenHash &&
          diskHash !== meta.lastWrittenHash,
      );
      const isPreAuthoredWithoutMeta = Boolean(
        diskContent !== null && !meta && diskContent.trim().length > 0 && diskContent.includes('## '),
      );

      let mergedState = state;
      const canReadActiveLedger =
        diskContent !== null && (!meta?.activeSessionId || meta.activeSessionId === session.id);
      const diskParsed = canReadActiveLedger ? parseWorkspaceLedgerMarkdown(diskContent) : null;
      const customSections = diskParsed?.customSections ?? [];
      const conflictDetected = isSameSessionConflict || isPreAuthoredWithoutMeta;

      if (conflictDetected && diskParsed) {
        const base = isSameSessionConflict && meta
          ? meta.lastSnapshot
          : { objective: '', pinnedFacts: [], decisions: [], blockers: [] };

        const mergedObjective = mergeObjective(base.objective, diskParsed.objective, state.objective, session.title);
        const mergedPinnedFacts = mergeStringLists(base.pinnedFacts, diskParsed.pinnedFacts, state.pinnedFacts);
        const mergedDecisions = mergeStringLists(base.decisions, diskParsed.decisions, state.decisions);
        const mergedBlockers = mergeStringLists(base.blockers, diskParsed.blockers, state.blockers);

        mergedState = {
          ...state,
          objective: mergedObjective,
          pinnedFacts: mergedPinnedFacts,
          decisions: mergedDecisions,
          blockers: mergedBlockers,
        };
      }

      let markdown = this.renderLedgerMarkdown(mergedState, session);
      if (customSections.length > 0) {
        const extra = customSections
          .map(({ heading, body }) => `## ${heading}\n\n${body}`.trim())
          .join('\n\n');
        markdown = `${markdown.trimEnd()}\n\n${extra}\n`;
      }

      atomicWriteFile(activeLedgerPath, markdown);
      atomicWriteFile(sessionLedgerPath, markdown);

      const nextMeta: WorkspaceLedgerMeta = {
        activeSessionId: session.id,
        lastWrittenHash: sha256Hex(markdown),
        lastSnapshot: {
          objective: mergedState.objective,
          pinnedFacts: [...mergedState.pinnedFacts],
          decisions: [...mergedState.decisions],
          blockers: [...mergedState.blockers],
        },
        updatedAt: Date.now(),
      };
      atomicWriteFile(metaPath, JSON.stringify(nextMeta, null, 2));

      return { ledgerFilePath: activeLedgerPath, state: mergedState, conflictDetected };
    } catch {
      return { ledgerFilePath: null, state, conflictDetected: false };
    }
  }
}

export function renderTaskLedgerMarkdown(
  state: SessionTaskState, session: Session, style: 'directive' | 'reference' = 'directive',
): string {
  const lines: string[] = [
    '# HarnessMate Task State Ledger',
    '',
    `- **Session**: ${session.title} (\`${session.id}\`)`,
    `- **Workspace**: \`${session.cwd}\``,
    `- **Active Harness**: \`${session.harnessId}\`${session.actualModel || session.model ? ` (${session.actualModel || session.model})` : ''}`,
    `- **Collaborating Harnesses**: ${(session.participatingHarnesses?.length ? session.participatingHarnesses : [session.harnessId]).join(', ')}`,
    ...(style === 'directive' ? [`- **Ledger Version**: v${state.version} · Updated ${new Date(state.updatedAt).toISOString()}`] : []),
    '',
  ];

  if (state.objective) {
    lines.push('## Objective', '', state.objective, '');
  }

  if (state.pinnedFacts.length > 0) {
    lines.push(style === 'reference' ? '## Previously Recorded Constraints' : '## Pinned Constraints (MUST FOLLOW — NEVER FORGET)', '');
    for (const fact of state.pinnedFacts) {
      lines.push(`- [PINNED] ${fact}`);
    }
    lines.push('');
  }

  if (state.steps.length > 0) {
    lines.push('## Plan & Progress', '');
    for (const step of state.steps) {
      const mark =
        step.status === 'done'
          ? '[x]'
          : step.status === 'in_progress'
            ? '[~]'
            : step.status === 'blocked'
              ? '[!]'
              : '[ ]';
      const owner = step.ownerHarnessId ? ` _(by ${step.ownerHarnessId})_` : '';
      lines.push(`- ${mark} ${step.title}${owner}`);
    }
    lines.push('');
  }

  if (state.decisions.length > 0) {
    lines.push('## Key Decisions', '');
    for (const d of state.decisions) {
      lines.push(`- ${d}`);
    }
    lines.push('');
  }

  if ((state.failedAttempts?.length ?? 0) > 0) {
    lines.push(
      style === 'reference'
        ? '## Previously Attempted Approaches (Failed)'
        : '## Failed Attempts (DO NOT REPEAT)',
      '',
    );
    for (const fa of state.failedAttempts!.slice(-8)) {
      const files = fa.relatedFiles?.length
        ? ` (files: ${fa.relatedFiles.slice(0, 5).map((f) => `\`${f}\``).join(', ')})`
        : '';
      lines.push(`- [${fa.harnessInstanceId || 'unknown'}] ${fa.summary} — Reason: ${fa.failureReason}${files}`);
    }
    lines.push('');
  }

  if (state.touchedFiles.length > 0) {
    lines.push('## Touched Files', '');
    for (const f of state.touchedFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  if (state.verifications.length > 0) {
    lines.push('## Verification Results', '');
    for (const v of state.verifications.slice(-8)) {
      const icon = v.status === 'pass' ? 'PASS' : v.status === 'fail' ? 'FAIL' : 'INFO';
      const by = v.harnessId ? ` [${v.harnessId}]` : '';
      lines.push(`- **${icon}**${by} \`${v.command}\`${v.summary ? ` — ${v.summary}` : ''}`);
    }
    lines.push('');
  }

  if (state.blockers.length > 0) {
    lines.push('## Open Blockers / Errors', '');
    for (const b of state.blockers) {
      lines.push(`- ${b}`);
    }
    lines.push('');
  }

  if (state.rollingSummary && style === 'directive') {
    lines.push('## Historical Digest', '', state.rollingSummary, '');
  }

  return `${lines.join('\n').trim()}\n`;
}

function atomicWriteFile(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

function hasGitRepoAncestor(startDir: string): boolean {
  let curr = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth++) {
    if (fs.existsSync(path.join(curr, '.git'))) return true;
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return false;
}

function compactSingleLine(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function isVerificationCommand(start: CanonicalEvent | undefined, command: string): boolean {
  if (start?.payload.toolKind !== 'shell') return false;
  const activeSegments = splitShellSegments(command).filter((seg) => !isReadOnlyCommandSegment(seg));
  if (activeSegments.length === 0) return false;
  return activeSegments.some((seg) => VERIFICATION_CMD_RE.test(seg));
}

function isAllReadOnlyShellCommand(command: string): boolean {
  const segments = splitShellSegments(command);
  return segments.length > 0 && segments.every((seg) => isReadOnlyCommandSegment(seg));
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (quote === ch) quote = null;
      else if (quote === null) quote = ch;
      current += ch;
      continue;
    }
    if (quote === null) {
      if (ch === '\n' || ch === '\r' || ch === ';' || ch === '|') {
        if (ch === '|' && command[i + 1] === '|') i += 1;
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
      if (ch === '&' && command[i + 1] === '&') {
        i += 1;
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function stripCommandWrappers(segment: string): string {
  let cleaned = segment.trim();
  if (!cleaned) return '';
  if (cleaned.startsWith('& ')) {
    cleaned = cleaned.slice(2).trim();
  }
  while (/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+|env\s+)/i.test(cleaned)) {
    cleaned = cleaned.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+|env\s+)/i, '').trim();
  }
  return cleaned;
}

function extractExecutableBasename(cleaned: string): string {
  if (!cleaned) return '';
  let firstToken = '';
  const first = cleaned[0];
  if (first === '"' || first === "'") {
    const closeIdx = cleaned.indexOf(first, 1);
    firstToken = closeIdx > 1 ? cleaned.slice(1, closeIdx) : cleaned.slice(1);
  } else {
    firstToken = cleaned.split(/\s+/)[0] ?? '';
  }
  const base = firstToken.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

function isReadOnlyCommandSegment(segment: string): boolean {
  const cleaned = stripCommandWrappers(segment);
  if (!cleaned) return true;
  const exe = extractExecutableBasename(cleaned);
  if (!exe) return true;
  if (READ_ONLY_EXECUTABLES.has(exe)) return true;
  if (
    exe === 'git' &&
    /^git\s+(?:-\S+(?:\s+\S+)?\s+)*(status|diff|log|show|branch|tag|remote|rev-parse|ls-files|ls-tree|blame|describe|shortlog|reflog|stash\s+list|config\s+(?:--get|--list))\b/i.test(
      cleaned,
    )
  ) {
    return true;
  }
  if (
    (exe === 'pnpm' || exe === 'npm' || exe === 'yarn' || exe === 'bun') &&
    /^(?:pnpm|npm|yarn|bun)\s+(?:list|ls|why|outdated|info|view|--version|-v)\b/i.test(cleaned)
  ) {
    return true;
  }
  if (exe === 'cargo' && /^cargo\s+(?:metadata|tree|version)\b/i.test(cleaned)) {
    return true;
  }
  if (exe === 'go' && /^go\s+(?:version|env|list)\b/i.test(cleaned)) {
    return true;
  }
  return false;
}

function upsertVerification(verifications: TaskVerification[], entry: TaskVerification): void {
  const key = compactSingleLine(entry.command, 160).toLowerCase();
  for (let i = verifications.length - 1; i >= 0; i--) {
    if (compactSingleLine(verifications[i]!.command, 160).toLowerCase() === key) {
      verifications.splice(i, 1);
    }
  }
  verifications.push(entry);
}

function normalizeFailedAttempt(
  input: {
    id?: string;
    summary: string;
    failureReason: string;
    relatedFiles?: string[];
    harnessInstanceId?: string | null;
    recordedAt?: number;
  },
  fallbackHarnessId: string | null,
  cwd: string,
): TaskFailedAttempt | null {
  const summary = compactSingleLine(input.summary, 300);
  if (!summary) return null;
  const failureReason = compactSingleLine(input.failureReason || 'Failed without error message', 500);
  const id = input.id?.trim() || `fail_${crypto.randomBytes(4).toString('hex')}`;
  const files: string[] = [];
  const seenFiles = new Set<string>();
  for (const raw of input.relatedFiles ?? []) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 260) continue;
    const rel = cwd ? normalizeRelativePath(trimmed, cwd) : trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel || rel.startsWith('.harnessmate/') || seenFiles.has(rel)) continue;
    seenFiles.add(rel);
    files.push(rel);
    if (files.length >= 12) break;
  }
  return {
    id,
    summary,
    failureReason,
    ...(files.length > 0 ? { relatedFiles: files } : {}),
    harnessInstanceId: input.harnessInstanceId !== undefined ? input.harnessInstanceId : fallbackHarnessId,
    recordedAt: typeof input.recordedAt === 'number' && Number.isFinite(input.recordedAt) ? input.recordedAt : Date.now(),
  };
}

function mergeFailedAttempts(
  existing: TaskFailedAttempt[],
  incoming: TaskFailedAttempt[],
  cap = MAX_FAILED_ATTEMPTS,
): TaskFailedAttempt[] {
  const merged = [...existing];
  const keyOf = (a: TaskFailedAttempt) =>
    `${a.summary.toLowerCase()}::${a.failureReason.slice(0, 120).toLowerCase()}`;

  for (const item of incoming) {
    const k = keyOf(item);
    const idx = merged.findIndex((prev) => prev.id === item.id || keyOf(prev) === k);
    if (idx >= 0) {
      const prev = merged[idx]!;
      merged.splice(idx, 1);
      const files = [...new Set([...(prev.relatedFiles ?? []), ...(item.relatedFiles ?? [])])].slice(0, 12);
      merged.push({
        ...prev,
        ...item,
        id: prev.id,
        recordedAt: Math.max(prev.recordedAt, item.recordedAt),
        harnessInstanceId: item.harnessInstanceId ?? prev.harnessInstanceId ?? null,
        ...(files.length > 0 ? { relatedFiles: files } : {}),
      });
    } else {
      merged.push(item);
    }
  }
  return merged.slice(-cap);
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function readWorkspaceLedgerMeta(metaPath: string): WorkspaceLedgerMeta | null {
  try {
    if (!fs.existsSync(metaPath)) return null;
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<WorkspaceLedgerMeta>;
    if (!raw || typeof raw.activeSessionId !== 'string' || typeof raw.lastWrittenHash !== 'string') {
      return null;
    }
    return {
      activeSessionId: raw.activeSessionId,
      lastWrittenHash: raw.lastWrittenHash,
      lastSnapshot: {
        objective: typeof raw.lastSnapshot?.objective === 'string' ? raw.lastSnapshot.objective : '',
        pinnedFacts: Array.isArray(raw.lastSnapshot?.pinnedFacts) ? raw.lastSnapshot.pinnedFacts.map(String) : [],
        decisions: Array.isArray(raw.lastSnapshot?.decisions) ? raw.lastSnapshot.decisions.map(String) : [],
        blockers: Array.isArray(raw.lastSnapshot?.blockers) ? raw.lastSnapshot.blockers.map(String) : [],
      },
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function parseWorkspaceLedgerMarkdown(markdown: string): {
  objective: string;
  pinnedFacts: string[];
  decisions: string[];
  blockers: string[];
  customSections: Array<{ heading: string; body: string }>;
} {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match?.[1]) {
      current = { heading: match[1].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }

  let objective = '';
  const pinnedFacts: string[] = [];
  const decisions: string[] = [];
  const blockers: string[] = [];
  const customSections: Array<{ heading: string; body: string }> = [];

  const parseBullets = (sectionLines: string[], stripPinned = false): string[] => {
    const out: string[] = [];
    for (const l of sectionLines) {
      const m = l.match(/^\s*[-*]\s+(.+)$/);
      if (!m?.[1]) continue;
      let val = m[1].trim();
      if (stripPinned) val = val.replace(/^\[PINNED\]\s*/i, '').trim();
      if (val) out.push(val);
    }
    return out;
  };

  for (const sec of sections) {
    const norm = sec.heading.toLowerCase();
    if (norm === 'objective' || norm === 'goal') {
      objective = sec.lines.join('\n').trim();
    } else if (norm.startsWith('pinned constraints') || norm === 'previously recorded constraints') {
      pinnedFacts.push(...parseBullets(sec.lines, true));
    } else if (norm === 'key decisions') {
      decisions.push(...parseBullets(sec.lines));
    } else if (norm === 'open blockers / errors') {
      blockers.push(...parseBullets(sec.lines));
    } else if (
      norm === 'plan & progress' ||
      norm === 'failed attempts (do not repeat)' ||
      norm === 'previously attempted approaches (failed)' ||
      norm === 'touched files' ||
      norm === 'verification results' ||
      norm === 'historical digest'
    ) {
      // known managed section
    } else {
      const body = sec.lines.join('\n').trim();
      if (body) {
        customSections.push({ heading: sec.heading, body });
      }
    }
  }

  return {
    objective,
    pinnedFacts: dedupeStrings(pinnedFacts),
    decisions: dedupeStrings(decisions),
    blockers: dedupeStrings(blockers),
    customSections,
  };
}

function mergeObjective(
  baseObj: string,
  diskObj: string,
  incomingObj: string,
  sessionTitle: string,
): string {
  if (!diskObj || diskObj === baseObj) {
    return incomingObj;
  }
  if (!incomingObj || incomingObj === baseObj || incomingObj === sessionTitle) {
    return diskObj;
  }
  return incomingObj;
}

function mergeStringLists(baseList: string[], diskList: string[], incomingList: string[]): string[] {
  const baseSet = new Set(baseList);
  const diskSet = new Set(diskList);
  const kept = incomingList.filter((item) => !(baseSet.has(item) && !diskSet.has(item)));
  const additions = diskList.filter((item) => !baseSet.has(item));
  return dedupeStrings([...kept, ...additions]);
}

export function readRecordedTurnEvidence(events: CanonicalEvent[], cwd: string) {
  const starts = new Map<string, CanonicalEvent>();
  const files = new Set<string>();
  const verifications: Array<{ command: string; status: 'pass' | 'fail' | 'unknown' }> = [];
  for (const event of events) {
    const payload = event.payload;
    if (typeof payload.toolCallId !== 'string') continue;
    if (event.type === 'tool.call.started') {
      starts.set(payload.toolCallId, event);
      continue;
    }
    const start = starts.get(payload.toolCallId);
    starts.delete(payload.toolCallId);
    if (event.type !== 'tool.call.completed') continue;

    const status = payload.status;
    const tool = start?.payload;
    const command = extractShellCommand(tool?.input, String(tool?.summary ?? ''));
    if (isVerificationCommand(start, command)) {
      const normalizedCmd = compactSingleLine(command, 160);
      const key = normalizedCmd.toLowerCase();
      for (let i = verifications.length - 1; i >= 0; i--) {
        if (compactSingleLine(verifications[i]!.command, 160).toLowerCase() === key) {
          verifications.splice(i, 1);
        }
      }
      if (verifications.length < 12) {
        verifications.push({
          command: normalizedCmd,
          status:
            status === 'success'
              ? 'pass'
              : status === 'error' || status === 'failed'
                ? 'fail'
                : 'unknown',
        });
      }
    }
    if (files.size >= 24 || status !== 'success') continue;
    const paths = extractFilePathsFromDiff(typeof payload.diff === 'string' ? payload.diff : '');
    if (tool) paths.push(...extractFilePathsFromTool(String(tool.toolKind ?? ''), String(tool.toolName ?? ''),
      String(tool.summary ?? ''), tool.input, cwd));
    for (const candidate of paths) {
      const relative = path.relative(cwd, path.resolve(cwd, candidate));
      if (relative && relative.length <= 260 && !path.isAbsolute(relative)
        && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
        files.add(relative.replace(/\\/g, '/'));
      }
      if (files.size >= 24) break;
    }
  }
  return { files: [...files], verifications };
}

function extractShellCommand(input: unknown, summary: string): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const candidate = obj.command ?? obj.cmd ?? obj.CommandLine;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate)) return candidate.map(String).join(' ').trim();
  }
  return summary.trim();
}

function extractFilePathsFromTool(
  toolKind: string,
  toolName: string,
  summary: string,
  input: unknown,
  cwd: string,
): string[] {
  if (toolKind !== 'file_edit' && !/write|edit|patch|create|modify/i.test(toolName)) {
    return [];
  }
  const found: string[] = [];
  const tryAdd = (val: unknown) => {
    if (typeof val !== 'string') return;
    const trimmed = val.trim();
    if (!trimmed || trimmed.length > 260) return;
    const rel = normalizeRelativePath(trimmed, cwd);
    if (rel && !rel.startsWith('.harnessmate/')) found.push(rel);
  };

  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'filePath', 'Path', 'target_file', 'TargetFile', 'file']) {
      tryAdd(obj[key]);
    }
    if (Array.isArray(obj.files)) {
      for (const f of obj.files) tryAdd(f);
    }
  }
  if (found.length === 0 && summary) {
    const match = summary.match(/([\w./\\-]+\.[a-zA-Z0-9]{1,8})/);
    if (match?.[1]) tryAdd(match[1]);
  }
  return found;
}

function extractFilePathsFromDiff(diff: string): string[] {
  if (!diff) return [];
  const files: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const m = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (m?.[1] && m[1] !== '/dev/null') {
      const clean = m[1].trim().replace(/\\/g, '/');
      if (!clean.startsWith('.harnessmate/')) files.push(clean);
    }
  }
  return files;
}

function normalizeRelativePath(rawPath: string, cwd: string): string {
  const normalizedCwd = path.resolve(cwd);
  let target = rawPath;
  if (path.isAbsolute(rawPath)) {
    const rel = path.relative(normalizedCwd, rawPath);
    if (!rel.startsWith('..')) {
      target = rel;
    }
  }
  return target.replace(/\\/g, '/').replace(/^\.\//, '');
}

function mergeMarkdownSteps(steps: TaskStep[], assistantText: string, harnessId: string): void {
  const regex = /^\s*[-*]\s+\[([ xX~])\]\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(assistantText)) !== null) {
    const mark = m[1]!;
    const title = m[2]!.trim().slice(0, 160);
    if (!title) continue;
    const status: TaskStep['status'] =
      mark === 'x' || mark === 'X' ? 'done' : mark === '~' ? 'in_progress' : 'pending';

    const existing = steps.find((s) => s.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      existing.status = status;
      existing.ownerHarnessId = harnessId;
      existing.updatedAt = Date.now();
    } else if (steps.length < 24) {
      steps.push({
        id: `step_${crypto.randomBytes(4).toString('hex')}`,
        title,
        status,
        ownerHarnessId: harnessId,
        updatedAt: Date.now(),
      });
    }
  }
}
