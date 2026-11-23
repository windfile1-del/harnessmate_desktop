import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CanonicalEvent,
  Session,
  SessionTaskState,
  TaskStep,
  UpdateTaskStateRequest,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { getGitStatusSummary } from './git-service.js';

const VERIFICATION_CMD_RE =
  /\b(test|vitest|jest|pytest|mocha|phpunit|rspec|typecheck|tsc|lint|eslint|biome|build|compile|check|gradle|gradlew|cargo\s+(test|check|build)|go\s+(test|vet|build)|pnpm\s+(test|build|typecheck|lint)|npm\s+(test|run\s+(test|build|lint|typecheck)))\b/i;

export class TaskLedgerService {
  constructor(private readonly store: HarnessMateStore,
    private readonly gitStatus: (cwd: string) => ReturnType<typeof getGitStatusSummary> | undefined) {}

  syncSession(session: Session): void {
    const state = this.getOrCreate(session);
    const ledgerFilePath = this.syncWorkspaceLedgerFile(session, state);
    if (ledgerFilePath && ledgerFilePath !== state.ledgerFilePath) this.store.upsertTaskState({ ...state, ledgerFilePath });
  }

  getOrCreate(session: Session): SessionTaskState {
    const existing = this.store.getTaskState(session.id);
    if (existing) return existing;
    return this.store.upsertTaskState({
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

  updateManual(session: Session, patch: UpdateTaskStateRequest): SessionTaskState {
    const current = this.getOrCreate(session);
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
      rollingSummary:
        patch.rollingSummary !== undefined ? patch.rollingSummary.trim() : current.rollingSummary,
      version: current.version + 1,
      updatedAt: Date.now(),
    };

    const ledgerPath = this.syncWorkspaceLedgerFile(session, next);
    if (ledgerPath) {
      next.ledgerFilePath = ledgerPath;
    }
    return this.store.upsertTaskState(next);
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
    const current = this.getOrCreate(session);
    let objective = current.objective;
    const steps = [...current.steps];
    const decisions = [...current.decisions];
    const touchedFiles = new Set<string>(current.touchedFiles);
    const verifications = [...current.verifications];
    const blockers = [...current.blockers];

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
        for (const f of extracted) touchedFiles.add(f);
      } else if (ev.type === 'tool.call.completed') {
        const toolName = String(p.toolName ?? '');
        const status = String(p.status ?? 'success');
        const output = String(p.output ?? '');
        const diff = String(p.diff ?? '');

        for (const f of extractFilePathsFromDiff(diff)) {
          touchedFiles.add(f);
        }

        const matchingStart = turnEvents.find(
          (e) => e.type === 'tool.call.started' && e.payload.toolCallId === p.toolCallId,
        );
        const cmdCandidate =
          extractShellCommand(matchingStart?.payload.input, String(matchingStart?.payload.summary ?? '')) ||
          toolName;

        if (isVerificationCommand(matchingStart, cmdCandidate)) {
          verifications.push({
            command: cmdCandidate.slice(0, 160),
            status: status === 'success' ? 'pass' : status === 'error' ? 'fail' : 'unknown',
            summary: compactSingleLine(output, 180) || (status === 'success' ? 'Exit 0' : 'Failed'),
            harnessId: turnHarnessId,
            timestamp: ev.createdAt,
          });
          if (status === 'error') {
            const failLine = `验证失败 (${cmdCandidate.slice(0, 80)}): ${compactSingleLine(output, 140) || '命令报错'}`;
            if (!blockers.includes(failLine)) blockers.push(failLine);
          } else if (status === 'success') {
            const cmdKey = cmdCandidate.slice(0, 40);
            for (let i = blockers.length - 1; i >= 0; i--) {
              if (blockers[i]!.includes(cmdKey)) {
                blockers.splice(i, 1);
              }
            }
          }
        }
      } else if (ev.type === 'turn.failed') {
        turnFailedMessage = String(p.message ?? '').trim();
      }
    }

    // Reconcile live git modified files (Workspace Truth) only when inside a git worktree
    try {
      if (hasGitRepoAncestor(session.cwd)) {
        const git = await this.gitStatus(session.cwd);
        if (git?.isGitRepo) {
          for (const ch of git.changes) {
            if (ch.path && !ch.path.startsWith('.harnessmate/')) {
              touchedFiles.add(ch.path);
            }
          }
        }
      }
    } catch {
      // ignore git errors on non-git folders
    }

    // Extract markdown checklist steps from assistant reply
    if (assistantText) {
      mergeMarkdownSteps(steps, assistantText, turnHarnessId);
    }

    if (turnFailedMessage) {
      const b = `[${turnHarnessId}] 轮次中断: ${compactSingleLine(turnFailedMessage, 160)}`;
      if (!blockers.includes(b)) blockers.push(b);
    }

    const next: SessionTaskState = {
      ...current,
      objective: objective || session.title,
      steps: steps.slice(-24),
      decisions: dedupeStrings(decisions).slice(-20),
      touchedFiles: Array.from(touchedFiles).slice(-40),
      verifications: verifications.slice(-16),
      blockers: dedupeStrings(blockers).slice(-12),
      pinnedFacts: current.pinnedFacts,
      rollingSummary: current.rollingSummary,
      summarizedUpToSeq: current.summarizedUpToSeq,
      version: current.version + 1,
      updatedAt: Date.now(),
    };

    const ledgerPath = this.syncWorkspaceLedgerFile(session, next);
    if (ledgerPath) {
      next.ledgerFilePath = ledgerPath;
    }

    return this.store.upsertTaskState(next);
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
    const ledgerPath = this.syncWorkspaceLedgerFile(session, next);
    if (ledgerPath) next.ledgerFilePath = ledgerPath;
    return this.store.upsertTaskState(next);
  }

  /**
   * Renders the Task State Ledger into crisp, structured Markdown suitable both
   * for injection into any Harness and for `<cwd>/.harnessmate/task-ledger.md`.
   */
  renderLedgerMarkdown(state: SessionTaskState, session: Session, style: 'directive' | 'reference' = 'directive'): string {
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

  /**
   * Mirrors the Task Ledger to `<cwd>/.harnessmate/task-ledger.md` and
   * `<cwd>/.harnessmate/sessions/<sessionId>.md` using atomic rename writes.
   */
  syncWorkspaceLedgerFile(session: Session, state: SessionTaskState): string | null {
    try {
      if (!session.cwd || !fs.existsSync(session.cwd)) return null;
      const hmDir = path.join(session.cwd, '.harnessmate');
      const sessionsDir = path.join(hmDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const markdown = this.renderLedgerMarkdown(state, session);
      const activeLedgerPath = path.join(hmDir, 'task-ledger.md');
      const sessionLedgerPath = path.join(sessionsDir, `${session.id}.md`);

      atomicWriteFile(activeLedgerPath, markdown);
      atomicWriteFile(sessionLedgerPath, markdown);
      return activeLedgerPath;
    } catch {
      return null;
    }
  }
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
  return start?.payload.toolKind === 'shell' && VERIFICATION_CMD_RE.test(command);
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
    if (verifications.length < 12 && isVerificationCommand(start, command)) {
      verifications.push({ command: compactSingleLine(command, 160),
        status: status === 'success' ? 'pass' : status === 'error' ? 'fail' : 'unknown' });
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
