import crypto from 'node:crypto';
import type {
  AttentionItem,
  CanonicalEvent,
  DelegateSubagentRequest,
  GitDryRunMergeResult,
  MergeSubagentRequest,
  OrchestratorBoardResponse,
  PermissionMode,
  Session,
  SubagentCohortSummary,
  SubagentDiffStat,
  SubagentRunRecord,
  SubagentStatus,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import { AgyAdapter } from '../harnesses/agy/agy-driver.js';
import {
  evaluateAgyConsumerProvenance,
  mintAgyDispatchProvenance,
} from '../harnesses/agy/native/wiring/provenance.js';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type { GitService } from '../plugin-host/builtin/services.js';
import type { TaskLedgerService } from './task-ledger-service.js';

export const ORCHESTRATOR_PLUGIN_ID = 'hm.plugin.multi-harness-orchestrator';
export const DEFAULT_MAX_DEPTH = 1;
export const HARD_MAX_DEPTH_CAP = 2;
export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 15 * 60 * 1000;

export class OrchestratorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly conflictFiles?: string[],
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

const PERMISSION_RANK: Record<PermissionMode, number> = {
  plan: 0,
  manual: 1,
  accept_edits: 2,
  auto: 3,
};

/**
 * Normalizes permission mode / approval policy aliases into canonical `PermissionMode`.
 */
export function normalizeApprovalPolicy(raw?: string | null): PermissionMode | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === 'plan' || v === 'read_only' || v === 'readonly') return 'plan';
  if (v === 'manual' || v === 'ask' || v === 'supervised' || v === 'confirm' || v === 'default') return 'manual';
  if (v === 'accept_edits' || v === 'acceptedits' || v === 'edits') return 'accept_edits';
  if (v === 'auto' || v === 'full_auto' || v === 'full-auto' || v === 'bypass' || v === 'yolo') return 'auto';
  return null;
}

/**
 * Enforces the No-Privilege-Escalation Ceiling:
 * `effectiveApprovalPolicy = min(parentPolicy, requestedPolicy)`.
 * A child subagent can narrow permissions (e.g. `accept_edits -> manual` or `plan`),
 * but can NEVER escalate above its parent session's approval policy.
 */
export function capApprovalPolicy(
  parentPolicy: PermissionMode,
  requestedPolicy?: string | null,
): PermissionMode {
  const normalized = normalizeApprovalPolicy(requestedPolicy);
  if (!normalized) return parentPolicy;
  return PERMISSION_RANK[normalized] <= PERMISSION_RANK[parentPolicy]
    ? normalized
    : parentPolicy;
}

export type OrchestratorWorktreePolicy = 'required_for_write' | 'optional' | 'always';

export interface OrchestratorConfig {
  maxDepth?: number;
  maxConcurrent?: number;
  defaultTimeoutMs?: number;
  worktreePolicy?: OrchestratorWorktreePolicy;
}

export interface OrchestratorHooks {
  createChildSession(opts: {
    parentSession: Session;
    targetInstanceId: string;
    roleTitle: string;
    cwd: string;
    worktreeBranch: string | null;
    permissionMode: PermissionMode;
    model?: string | null;
  }): Promise<Session>;
  sendTurn(
    sessionId: string,
    text: string,
    opts?: { omitHandoff?: boolean; literalText?: boolean },
  ): Promise<{ turnId: string }>;
  interruptSession(sessionId: string): Promise<void>;
  disposeSessionHandles(sessionId: string): Promise<void>;
  emitCanonical(
    sessionId: string,
    type: CanonicalEvent['type'],
    payload: Record<string, unknown>,
    turnId?: string | null,
  ): CanonicalEvent;
  publishAttention(item: AttentionItem): void;
  getGitService(): GitService | undefined;
  getTaskLedger(): TaskLedgerService | undefined;
  isOrchestratorEnabled(): boolean;
  resolveTargetAdapter?(targetInstanceId: string, parentSession: Session): import('../harnesses/types.js').HarnessAdapter | undefined;
  getSession?(sessionId: string): Promise<Session | null>;
  getWorkspace?(workspaceId: string): Promise<{ id: string; rootPath: string; name: string } | null>;
}

interface PendingWakeupEntry {
  cohortId: string;
  summaryMarkdown: string;
  subagents: SubagentRunRecord[];
  createdAt: number;
}

const ACTIVE_SUBAGENT_STATUSES: SubagentStatus[] = ['queued', 'running', 'awaiting_approval'];
const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentStatus>(['completed', 'failed', 'stopped']);

export class OrchestratorService {
  private hooks: OrchestratorHooks | null = null;
  private maxDepth: number;
  private maxConcurrent: number;
  private defaultTimeoutMs: number;
  private worktreePolicy: OrchestratorWorktreePolicy;
  private readonly subagentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingWakeupsByParent = new Map<string, PendingWakeupEntry[]>();
  private readonly deliveredCohorts = new Set<string>();
  private readonly drainingParents = new Set<string>();
  private readonly settlingChildren = new Set<string>();
  private readonly wakeupDeliveriesByParent = new Map<string, number>();

  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    config?: OrchestratorConfig,
  ) {
    this.maxDepth = Math.max(1, Math.floor(config?.maxDepth ?? DEFAULT_MAX_DEPTH));
    this.maxConcurrent = Math.max(1, Math.floor(config?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
    this.defaultTimeoutMs = Math.max(200, Math.floor(config?.defaultTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS));
    this.worktreePolicy = config?.worktreePolicy ?? 'required_for_write';
  }

  attachHooks(hooks: OrchestratorHooks): void {
    this.hooks = hooks;
  }

  configure(patch: OrchestratorConfig): void {
    if (patch.maxDepth !== undefined) {
      this.maxDepth = Math.max(1, Math.floor(patch.maxDepth));
    }
    if (patch.maxConcurrent !== undefined) {
      this.maxConcurrent = Math.max(1, Math.floor(patch.maxConcurrent));
    }
    if (patch.defaultTimeoutMs !== undefined) {
      this.defaultTimeoutMs = Math.max(200, Math.floor(patch.defaultTimeoutMs));
    }
    if (patch.worktreePolicy !== undefined) {
      this.worktreePolicy = patch.worktreePolicy;
    }
  }

  getLimits(): {
    maxDepth: number;
    maxConcurrent: number;
    defaultTimeoutMs: number;
    worktreePolicy: OrchestratorWorktreePolicy;
  } {
    return {
      maxDepth: this.maxDepth,
      maxConcurrent: this.maxConcurrent,
      defaultTimeoutMs: this.defaultTimeoutMs,
      worktreePolicy: this.worktreePolicy,
    };
  }

  getWakeupCount(parentSessionId: string): number {
    return this.wakeupDeliveriesByParent.get(parentSessionId) ?? 0;
  }

  /**
   * Computes orchestration nesting depth of a session (0 = root parent, 1 = direct child, etc.).
   */
  computeSessionDepth(sessionId: string): number {
    let depth = 0;
    const visited = new Set<string>();
    let currentId: string | null | undefined = sessionId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const run = this.store.getSubagentRunByChildSession(currentId);
      if (run) {
        return depth + run.depth;
      }
      const sess = this.store.getSession(currentId);
      if (!sess?.parentSessionId) break;
      // Only count orchestrator subagent hierarchy when checking parent chain
      const parentRun = this.store.getSubagentRunByChildSession(sess.parentSessionId);
      if (parentRun) {
        return depth + 1 + parentRun.depth;
      }
      currentId = sess.parentSessionId;
      // Do not falsely treat a normal user-forked session as depth>0 unless part of subagent tree
      break;
    }
    return depth;
  }

  private requireHooks(): OrchestratorHooks {
    if (!this.hooks) {
      throw new OrchestratorError('E_ORCHESTRATOR_NOT_READY', 'Orchestrator service hooks are not initialized');
    }
    return this.hooks;
  }

  private assertEnabled(): void {
    const hooks = this.requireHooks();
    if (!hooks.isOrchestratorEnabled()) {
      throw new OrchestratorError(
        'E_PLUGIN_DISABLED',
        'Multi-Harness Parallel Orchestrator 插件当前未启用，请先在插件管理中启用后再试。',
      );
    }
  }

  // ── Delegation (Scenario D: 1 Parent -> N Isolated Children) ─────────

  async delegateTask(
    parentSessionId: string,
    req: DelegateSubagentRequest,
  ): Promise<SubagentRunRecord> {
    this.assertEnabled();
    const hooks = this.requireHooks();

    const parent = (await hooks.getSession?.(parentSessionId)) ?? this.store.getSession(parentSessionId);
    if (!parent || parent.status === 'archived') {
      throw new OrchestratorError('E_SESSION_NOT_FOUND', `Parent session not found or archived: ${parentSessionId}`);
    }

    // Plugin-configured recursion depth cap (default plugin setting: maxDepth = 1)
    const currentDepth = this.computeSessionDepth(parentSessionId);
    const nextDepth = currentDepth + 1;
    if (nextDepth > this.maxDepth) {
      throw new OrchestratorError(
        'E_MAX_DEPTH_EXCEEDED',
        `Subagent nesting depth limit exceeded (depth ${nextDepth} > maxDepth ${this.maxDepth}). Subagents cannot recursively spawn deeper subagents.`,
      );
    }

    // Plugin-configured per-parent concurrency cap (default: maxConcurrent = 4)
    const activeRuns = this.store.listSubagentRuns({
      parentSessionId,
      statuses: ACTIVE_SUBAGENT_STATUSES,
    });
    if (activeRuns.length >= this.maxConcurrent) {
      throw new OrchestratorError(
        'E_MAX_CONCURRENT_EXCEEDED',
        `Maximum concurrent subagents reached (${activeRuns.length}/${this.maxConcurrent}) for parent session ${parentSessionId}. Please wait for active subagents to finish or stop one before delegating another task.`,
      );
    }

    // Validate target harness instance (prefer scoped driver lookup when provided)
    const adapter = hooks.resolveTargetAdapter?.(req.targetInstanceId, parent) ?? this.registry.get(req.targetInstanceId);
    if (!adapter) {
      throw new OrchestratorError(
        'E_TARGET_INSTANCE_NOT_FOUND',
        `Target harness instance not registered: ${req.targetInstanceId}`,
      );
    }

    // Consumer AGY provenance guard: never delegate consumer OAuth AGY as a background HM worker
    const targetDriverId = adapter.driverId ?? adapter.kind;
    const provenanceDecision = evaluateAgyConsumerProvenance(
      {
        instanceId: adapter.id,
        driverId: targetDriverId,
        profile: adapter instanceof AgyAdapter ? adapter.getProfile() : null,
      },
      mintAgyDispatchProvenance('hm_orchestrator_delegation', 'system', 'orchestrator.delegate'),
    );
    if (!provenanceDecision.allowed) {
      throw new OrchestratorError(
        'E_CONSUMER_PROVENANCE_BLOCKED',
        provenanceDecision.reason ?? 'Consumer AGY instance cannot be used as an automated orchestrator worker',
      );
    }

    // Guardrail 2: No Privilege Escalation Ceiling
    const normalizedRequested = normalizeApprovalPolicy(req.requestedApprovalPolicy);
    const effectiveApprovalPolicy = capApprovalPolicy(parent.permissionMode, req.requestedApprovalPolicy);

    const workspace = (await hooks.getWorkspace?.(parent.workspaceId)) ?? this.store.getWorkspace(parent.workspaceId);
    if (!workspace) {
      throw new OrchestratorError('E_WORKSPACE_NOT_FOUND', `Workspace not found: ${parent.workspaceId}`);
    }

    const git = hooks.getGitService();
    if (!git) {
      throw new OrchestratorError('E_SERVICE_UNAVAILABLE', 'Git service is unavailable');
    }

    const subagentId = `sub_${crypto.randomBytes(5).toString('hex')}`;
    const cohortId = req.cohortId?.trim() || `cohort_${crypto.randomBytes(4).toString('hex')}`;
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const failFast = Boolean(req.failFast);

    let childCwd = parent.cwd;
    let worktreePath: string | null = null;
    let branchName: string | null = null;
    let baseBranch: string | null = null;

    const wantsWorktree =
      this.worktreePolicy === 'always' ||
      req.isolation === 'worktree_write';
    if (wantsWorktree) {
      const repoInfo = await git.inspect(workspace.rootPath);
      if (repoInfo.isGitRepo) {
        baseBranch = req.baseBranch?.trim() || repoInfo.branch || 'main';
        const targetBranch = `hm/sub/${subagentId}`;
        const wt = await git.createWorktree(workspace.rootPath, targetBranch, { baseBranch });
        childCwd = wt.worktreePath;
        worktreePath = wt.worktreePath;
        branchName = wt.branch;
      } else if (req.isolation === 'worktree_write' && this.worktreePolicy !== 'optional') {
        throw new OrchestratorError('E_GIT_REPO_REQUIRED', 'Write delegation requires a Git repository');
      }
    }

    // Create first-class Core child session linked via parentSessionId
    let childSession: Session;
    try {
      childSession = await hooks.createChildSession({
        parentSession: parent,
        targetInstanceId: adapter.id,
        roleTitle: req.roleTitle,
        cwd: childCwd,
        worktreeBranch: branchName,
        permissionMode: effectiveApprovalPolicy,
        model: req.model ?? null,
      });
    } catch (err) {
      // If session creation fails after worktree allocation, leave no broken state
      throw err;
    }

    const now = Date.now();
    const record = this.store.createSubagentRun({
      subagentId,
      cohortId,
      parentSessionId: parent.id,
      childSessionId: childSession.id,
      targetInstanceId: adapter.id,
      targetDriverId: adapter.kind,
      roleTitle: req.roleTitle,
      prompt: req.prompt,
      isolation: req.isolation,
      worktreePath,
      branchName,
      baseBranch,
      effectiveApprovalPolicy,
      requestedApprovalPolicy: normalizedRequested,
      depth: nextDepth,
      timeoutMs,
      failFast,
      status: 'running',
      diffStat: null,
      summary: null,
      error: null,
      mergedAt: null,
      mergedIntoBranch: null,
      worktreeCleaned: false,
      createdAt: now,
      finishedAt: null,
    });

    // Reset cohort delivery tracking if a new subagent joins an existing cohort
    this.deliveredCohorts.delete(cohortId);

    hooks.emitCanonical(parent.id, 'subagent.spawned', {
      subagent: record,
      cohortId,
      subagentId,
      childSessionId: childSession.id,
      targetInstanceId: adapter.id,
      roleTitle: req.roleTitle,
      isolation: req.isolation,
      branchName,
      effectiveApprovalPolicy,
    });

    hooks.publishAttention({
      kind: 'session_updated',
      sessionId: parent.id,
      sessionTitle: parent.title,
      harnessId: adapter.id,
      summary: `已派生并行子任务：${req.roleTitle} (${adapter.id})`,
      timestamp: now,
    });

    this.syncTaskLedgerStep(parent.id, record);
    this.armSubagentTimer(subagentId, timeoutMs);

    // Build clean, isolated subtask prompt (Scenario D: zero full parent history bloat, focused SubtaskSpec)
    const isolationHeader =
      req.isolation === 'worktree_write'
        ? `[Orchestrator Subtask · Isolated Git Worktree]\nRole: ${req.roleTitle}\nBranch: ${branchName} (base: ${baseBranch})\nWorking Directory: ${childCwd}\nRules: Perform your assigned implementation strictly inside this isolated worktree. Provide a concise final summary when done.\n\n`
        : `[Orchestrator Subtask · Read-Only Research/Review]\nRole: ${req.roleTitle}\nIsolation: read_only (DO NOT modify repository files)\nWorking Directory: ${childCwd}\nRules: Perform read-only inspection/review only and report structured findings.\n\n`;

    const composedPrompt = `${isolationHeader}${req.prompt}`;

    try {
      await hooks.sendTurn(childSession.id, composedPrompt, {
        omitHandoff: true,
        literalText: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.handleChildTerminal(childSession.id, 'failed', msg);
    }

    return this.store.getSubagentRun(subagentId) ?? record;
  }

  // ── Inspection, Follow-up & Stop Controls ────────────────────────────

  getBoard(parentSessionId: string): OrchestratorBoardResponse {
    const enabled = this.hooks?.isOrchestratorEnabled() ?? false;
    const runs = this.store.listSubagentRuns({ parentSessionId }).map((run) => ({
      ...run,
      pendingApprovalCount: this.store.listPendingApprovals(run.childSessionId).length,
    }));
    const activeCount = runs.filter((r) => ACTIVE_SUBAGENT_STATUSES.includes(r.status)).length;
    const currentDepth = this.computeSessionDepth(parentSessionId);

    const byCohort = new Map<string, SubagentRunRecord[]>();
    for (const run of runs) {
      const bucket = byCohort.get(run.cohortId) ?? [];
      bucket.push(run);
      byCohort.set(run.cohortId, bucket);
    }

    const queuedCohortIds = new Set(
      (this.pendingWakeupsByParent.get(parentSessionId) ?? []).map((w) => w.cohortId),
    );

    const cohorts: SubagentCohortSummary[] = [];
    for (const [cohortId, items] of byCohort) {
      const completedCount = items.filter((i) => i.status === 'completed').length;
      const failedCount = items.filter((i) => i.status === 'failed').length;
      const stoppedCount = items.filter((i) => i.status === 'stopped').length;
      const runningCount = items.filter((i) => ACTIVE_SUBAGENT_STATUSES.includes(i.status)).length;
      const status: SubagentCohortSummary['status'] =
        runningCount > 0
          ? 'running'
          : failedCount === items.length
            ? 'failed'
            : failedCount > 0 || stoppedCount > 0
              ? 'partial'
              : 'completed';
      const createdAt = Math.min(...items.map((i) => i.createdAt));
      const finishedTimes = items.map((i) => i.finishedAt).filter((t): t is number => typeof t === 'number');
      cohorts.push({
        cohortId,
        parentSessionId,
        status,
        total: items.length,
        completedCount,
        failedCount,
        stoppedCount,
        runningCount,
        wakeupDelivered: this.deliveredCohorts.has(cohortId) && !queuedCohortIds.has(cohortId),
        wakeupQueued: queuedCohortIds.has(cohortId),
        subagents: items,
        createdAt,
        completedAt: runningCount === 0 && finishedTimes.length > 0 ? Math.max(...finishedTimes) : null,
      });
    }
    cohorts.sort((a, b) => b.createdAt - a.createdAt);

    return {
      parentSessionId,
      enabled,
      activeCount,
      maxConcurrent: this.maxConcurrent,
      maxDepth: this.maxDepth,
      currentDepth,
      subagents: runs,
      cohorts,
    };
  }

  listSubagents(parentSessionId: string, opts?: { cohortId?: string; status?: SubagentStatus }): SubagentRunRecord[] {
    return this.store
      .listSubagentRuns({
        parentSessionId,
        cohortId: opts?.cohortId,
        statuses: opts?.status ? [opts.status] : undefined,
      })
      .map((run) => ({
        ...run,
        pendingApprovalCount: this.store.listPendingApprovals(run.childSessionId).length,
      }));
  }

  getSubagentResult(subagentId: string): {
    subagent: SubagentRunRecord;
    pendingApprovals: ReturnType<HarnessMateStore['listPendingApprovals']>;
    recentOutput: string;
  } {
    const run = this.store.getSubagentRun(subagentId);
    if (!run) {
      throw new OrchestratorError('E_SUBAGENT_NOT_FOUND', `Subagent not found: ${subagentId}`);
    }
    const pendingApprovals = this.store.listPendingApprovals(run.childSessionId);
    const recentOutput = run.summary || this.extractLatestAssistantSummary(run.childSessionId) || '';
    return {
      subagent: {
        ...run,
        pendingApprovalCount: pendingApprovals.length,
      },
      pendingApprovals,
      recentOutput,
    };
  }

  async sendToSubagent(subagentId: string, text: string): Promise<{ subagent: SubagentRunRecord; turnId: string }> {
    this.assertEnabled();
    const hooks = this.requireHooks();
    const run = this.store.getSubagentRun(subagentId);
    if (!run) {
      throw new OrchestratorError('E_SUBAGENT_NOT_FOUND', `Subagent not found: ${subagentId}`);
    }
    const child = this.store.getSession(run.childSessionId);
    if (!child || child.status === 'archived') {
      throw new OrchestratorError('E_SESSION_NOT_FOUND', `Child session is missing or archived: ${run.childSessionId}`);
    }
    if (child.status === 'running' || child.status === 'awaiting_approval') {
      throw new OrchestratorError('E_SUBAGENT_BUSY', `Subagent ${subagentId} is currently busy (${child.status})`);
    }

    this.deliveredCohorts.delete(run.cohortId);
    this.store.updateSubagentRun(subagentId, {
      status: 'running',
      error: null,
      finishedAt: null,
    });
    this.armSubagentTimer(subagentId, run.timeoutMs);

    const updatedRunning = this.store.getSubagentRun(subagentId)!;
    hooks.emitCanonical(run.parentSessionId, 'subagent.updated', { subagent: updatedRunning });

    const { turnId } = await hooks.sendTurn(run.childSessionId, text, {
      omitHandoff: true,
      literalText: true,
    });
    return {
      subagent: this.store.getSubagentRun(subagentId) ?? updatedRunning,
      turnId,
    };
  }

  async stopSubagent(
    subagentId: string,
    reason = 'Stopped by coordinator or user',
    opts?: { suppressWakeup?: boolean },
  ): Promise<SubagentRunRecord> {
    const hooks = this.requireHooks();
    const run = this.store.getSubagentRun(subagentId);
    if (!run) {
      throw new OrchestratorError('E_SUBAGENT_NOT_FOUND', `Subagent not found: ${subagentId}`);
    }
    this.clearSubagentTimer(subagentId);
    if (TERMINAL_SUBAGENT_STATUSES.has(run.status)) {
      return run;
    }

    // Mark settling before interrupt so handleChildTerminal doesn't double-process
    this.settlingChildren.add(run.childSessionId);
    try {
      await hooks.interruptSession(run.childSessionId).catch(() => {});
      const diffStat = await this.snapshotWorktreeAndDiffStat(run, `chore(subagent): snapshot before stop (${run.roleTitle})`);
      const summary = this.extractLatestAssistantSummary(run.childSessionId) ?? run.summary ?? null;
      const updated =
        this.store.updateSubagentRun(subagentId, {
          status: 'stopped',
          error: reason,
          summary,
          diffStat,
          finishedAt: Date.now(),
        }) ?? run;

      hooks.emitCanonical(run.parentSessionId, 'subagent.updated', {
        subagent: updated,
        reason,
      });
      this.syncTaskLedgerStep(run.parentSessionId, updated);

      if (!opts?.suppressWakeup) {
        await this.evaluateCohortCompletion(updated.cohortId);
      }
      return updated;
    } finally {
      this.settlingChildren.delete(run.childSessionId);
    }
  }

  // ── Dry-Run Merge Pre-Check, Human-Confirmed Merge-Back & Cleanup ────

  async dryRunMergeSubagent(
    subagentId: string,
    baseBranchOverride?: string,
  ): Promise<{
    subagent: SubagentRunRecord;
    dryRun: GitDryRunMergeResult;
    diffStat: SubagentDiffStat;
  }> {
    const hooks = this.requireHooks();
    const git = hooks.getGitService();
    if (!git) {
      throw new OrchestratorError('E_SERVICE_UNAVAILABLE', 'Git service is unavailable');
    }
    const run = this.store.getSubagentRun(subagentId);
    if (!run) {
      throw new OrchestratorError('E_SUBAGENT_NOT_FOUND', `Subagent not found: ${subagentId}`);
    }
    if (run.isolation !== 'worktree_write' || !run.branchName) {
      throw new OrchestratorError(
        'E_NOT_WORKTREE_SUBAGENT',
        `Subagent ${subagentId} is read-only and has no isolated worktree branch to merge`,
      );
    }
    const parent = this.store.getSession(run.parentSessionId);
    const workspace = parent ? this.store.getWorkspace(parent.workspaceId) : null;
    if (!workspace) {
      throw new OrchestratorError('E_WORKSPACE_NOT_FOUND', 'Parent workspace not found');
    }

    const repoInfo = await git.inspect(workspace.rootPath);
    if (!repoInfo.isGitRepo) {
      throw new OrchestratorError('E_GIT_REPO_REQUIRED', 'Workspace is not a Git repository');
    }
    const baseBranch = baseBranchOverride?.trim() || run.baseBranch || repoInfo.branch || 'main';

    // Ensure uncommitted worktree edits are captured on the isolated child branch before dry-run
    const diffStat =
      (await this.snapshotWorktreeAndDiffStat(run, `chore(subagent): ${run.roleTitle}`)) ??
      { filesChanged: 0, insertions: 0, deletions: 0, changedFiles: [] };

    const dryRun = await git.dryRunMerge(workspace.rootPath, baseBranch, run.branchName);
    const updated = this.store.updateSubagentRun(subagentId, { diffStat }) ?? run;
    return { subagent: updated, dryRun, diffStat };
  }

  async mergeBackSubagent(
    subagentId: string,
    req: MergeSubagentRequest,
  ): Promise<{
    subagentId: string;
    branchName: string;
    baseBranch: string;
    merged: boolean;
    commitSha: string | null;
    worktreeCleaned: boolean;
    branchDeleted: boolean;
    dryRun: GitDryRunMergeResult;
    message: string;
  }> {
    // Hard Safety Rule: NEVER auto-merge without explicit human confirmation
    if (!req.confirmMerge) {
      throw new OrchestratorError(
        'E_CONFIRMATION_REQUIRED',
        'Merge-back requires explicit human confirmation (confirmMerge: true). Auto-merge is strictly prohibited.',
      );
    }

    const hooks = this.requireHooks();
    const git = hooks.getGitService();
    if (!git) {
      throw new OrchestratorError('E_SERVICE_UNAVAILABLE', 'Git service is unavailable');
    }
    const run = this.store.getSubagentRun(subagentId);
    if (!run) {
      throw new OrchestratorError('E_SUBAGENT_NOT_FOUND', `Subagent not found: ${subagentId}`);
    }
    if (ACTIVE_SUBAGENT_STATUSES.includes(run.status)) {
      throw new OrchestratorError(
        'E_SUBAGENT_ACTIVE',
        `Cannot merge active subagent ${subagentId} (status: ${run.status}). Stop or wait for completion first.`,
      );
    }
    if (run.isolation !== 'worktree_write' || !run.branchName) {
      throw new OrchestratorError(
        'E_NOT_WORKTREE_SUBAGENT',
        `Subagent ${subagentId} does not have an isolated worktree branch`,
      );
    }

    const parent = this.store.getSession(run.parentSessionId);
    const workspace = parent ? this.store.getWorkspace(parent.workspaceId) : null;
    if (!workspace) {
      throw new OrchestratorError('E_WORKSPACE_NOT_FOUND', 'Parent workspace not found');
    }

    const repoInfo = await git.inspect(workspace.rootPath);
    if (!repoInfo.isGitRepo) {
      throw new OrchestratorError('E_GIT_REPO_REQUIRED', 'Workspace is not a Git repository');
    }
    const baseBranch = req.baseBranch?.trim() || run.baseBranch || repoInfo.branch || 'main';

    // 1. Commit any pending edits inside the isolated child worktree
    await this.snapshotWorktreeAndDiffStat(run, `chore(subagent): ${run.roleTitle}`);

    // 2. Mandatory zero-side-effect dry-run merge conflict pre-check
    const dryRun = await git.dryRunMerge(workspace.rootPath, baseBranch, run.branchName);
    if (dryRun.hasConflicts) {
      throw new OrchestratorError(
        'E_MERGE_CONFLICT',
        `合并预检发现 ${dryRun.conflictFiles.length} 个冲突文件，已阻止合并以防污染主工作区: ${dryRun.conflictFiles.join(', ')}`,
        dryRun.conflictFiles,
      );
    }

    // 3. Execute explicit merge into baseBranch
    const mergeRes = await git.mergeBranchExplicit(workspace.rootPath, baseBranch, run.branchName, {
      commitMessage: req.commitMessage ?? `Merge subagent '${run.roleTitle}' (${run.branchName}) into ${baseBranch}`,
    });

    // 4. Optional safe Worktree & branch cleanup after confirmed merge
    let worktreeCleaned = Boolean(run.worktreeCleaned);
    let branchDeleted = false;
    if (req.cleanupWorktree && run.worktreePath && !worktreeCleaned) {
      await hooks.disposeSessionHandles(run.childSessionId).catch(() => {});
      await git.removeWorktree(workspace.rootPath, run.worktreePath, { force: true });
      worktreeCleaned = true;
      if (req.deleteBranch) {
        branchDeleted = await git.deleteLocalBranch(workspace.rootPath, run.branchName);
      }
    }

    const now = Date.now();
    const updated =
      this.store.updateSubagentRun(subagentId, {
        mergedAt: now,
        mergedIntoBranch: baseBranch,
        worktreeCleaned,
      }) ?? run;

    hooks.emitCanonical(run.parentSessionId, 'subagent.merged', {
      subagent: updated,
      subagentId,
      branchName: run.branchName,
      baseBranch,
      commitSha: mergeRes.commitSha,
      worktreeCleaned,
      branchDeleted,
    });

    // Refresh cohort chat block so UI immediately reflects merged state
    this.upsertCohortBlock(run.parentSessionId, run.cohortId);

    return {
      subagentId,
      branchName: run.branchName,
      baseBranch,
      merged: true,
      commitSha: mergeRes.commitSha,
      worktreeCleaned,
      branchDeleted,
      dryRun,
      message: worktreeCleaned
        ? `已成功合回 ${run.branchName} → ${baseBranch} 并安全清理隔离 Worktree`
        : `已成功合回 ${run.branchName} → ${baseBranch}（Worktree 分支已保留）`,
    };
  }

  async cleanupSubagentWorktree(
    subagentId: string,
    opts?: { force?: boolean; deleteBranch?: boolean },
  ): Promise<{ subagent: SubagentRunRecord; worktreeCleaned: boolean; branchDeleted: boolean }> {
    const hooks = this.requireHooks();
    const git = hooks.getGitService();
    if (!git) {
      throw new OrchestratorError('E_SERVICE_UNAVAILABLE', 'Git service is unavailable');
    }
    const run = this.store.getSubagentRun(subagentId);
    if (!run) {
      throw new OrchestratorError('E_SUBAGENT_NOT_FOUND', `Subagent not found: ${subagentId}`);
    }
    if (ACTIVE_SUBAGENT_STATUSES.includes(run.status)) {
      throw new OrchestratorError('E_SUBAGENT_ACTIVE', '请先停止运行中的子任务后再清理 Worktree');
    }
    if (!run.worktreePath) {
      return { subagent: run, worktreeCleaned: false, branchDeleted: false };
    }
    const parent = this.store.getSession(run.parentSessionId);
    const workspace = parent ? this.store.getWorkspace(parent.workspaceId) : null;
    if (!workspace) {
      throw new OrchestratorError('E_WORKSPACE_NOT_FOUND', 'Parent workspace not found');
    }

    await hooks.disposeSessionHandles(run.childSessionId).catch(() => {});
    await git.removeWorktree(workspace.rootPath, run.worktreePath, { force: opts?.force ?? true });
    let branchDeleted = false;
    if (opts?.deleteBranch && run.branchName) {
      branchDeleted = await git.deleteLocalBranch(workspace.rootPath, run.branchName);
    }
    const updated = this.store.updateSubagentRun(subagentId, { worktreeCleaned: true }) ?? run;
    hooks.emitCanonical(run.parentSessionId, 'subagent.updated', { subagent: updated });
    this.upsertCohortBlock(run.parentSessionId, run.cohortId);
    return { subagent: updated, worktreeCleaned: true, branchDeleted };
  }

  // ── Lifecycle & Event Wiring ─────────────────────────────────────────

  async handleChildTurnCompleted(childSessionId: string): Promise<void> {
    await this.handleChildTerminal(childSessionId, 'completed');
  }

  async handleChildTurnFailed(childSessionId: string, message?: string | null): Promise<void> {
    await this.handleChildTerminal(childSessionId, 'failed', message ?? 'Subagent turn failed');
  }

  async handleChildTurnCancelled(childSessionId: string): Promise<void> {
    await this.handleChildTerminal(childSessionId, 'stopped', 'Subagent turn cancelled');
  }

  handleChildApprovalRequested(childSessionId: string, approvalId: string, toolName: string): void {
    const run = this.store.getSubagentRunByChildSession(childSessionId);
    if (!run || TERMINAL_SUBAGENT_STATUSES.has(run.status)) return;
    const updated = this.store.updateSubagentRun(run.subagentId, { status: 'awaiting_approval' });
    if (updated && this.hooks) {
      this.hooks.emitCanonical(run.parentSessionId, 'subagent.updated', {
        subagent: {
          ...updated,
          pendingApprovalCount: this.store.listPendingApprovals(childSessionId).length,
        },
        approvalId,
        toolName,
      });
    }
  }

  handleChildApprovalResolved(childSessionId: string): void {
    const run = this.store.getSubagentRunByChildSession(childSessionId);
    if (!run || run.status !== 'awaiting_approval') return;
    const pending = this.store.listPendingApprovals(childSessionId);
    if (pending.length > 0) return;
    const updated = this.store.updateSubagentRun(run.subagentId, { status: 'running' });
    if (updated && this.hooks) {
      this.hooks.emitCanonical(run.parentSessionId, 'subagent.updated', {
        subagent: { ...updated, pendingApprovalCount: 0 },
      });
    }
  }

  /**
   * Cascade-stops all active child subagents when the parent session is closed or interrupted,
   * while 100% preserving all unmerged Worktree branches on disk.
   */
  async cascadeStopChildren(parentSessionId: string, reason = 'Parent session closed or interrupted'): Promise<number> {
    this.pendingWakeupsByParent.delete(parentSessionId);
    const active = this.store.listSubagentRuns({
      parentSessionId,
      statuses: ACTIVE_SUBAGENT_STATUSES,
    });
    for (const run of active) {
      await this.stopSubagent(run.subagentId, reason, { suppressWakeup: true }).catch(() => {});
    }
    return active.length;
  }

  /**
   * Called when a parent session transitions back to `idle` after a turn completes/fails/cancels.
   * Drains all queued cohort wakeups for this parent into ONE SINGLE aggregated wakeup.
   */
  onParentSessionIdle(parentSessionId: string): void {
    const queue = this.pendingWakeupsByParent.get(parentSessionId);
    if (!queue || queue.length === 0) return;
    if (this.drainingParents.has(parentSessionId)) return;
    const parent = this.store.getSession(parentSessionId);
    if (!parent || parent.status !== 'idle') return;

    this.drainingParents.add(parentSessionId);
    // Defer to microtask so parent turn completion bookkeeping finishes first
    queueMicrotask(() => {
      void this.drainPendingWakeups(parentSessionId).finally(() => {
        this.drainingParents.delete(parentSessionId);
      });
    });
  }

  /**
   * Converges any orphaned active subagent records to `stopped` on startup or plugin activation.
   * Strictly preserves all unmerged Worktree directories & Git branches.
   */
  recoverOrphanedRuns(): number {
    const settled = this.store.settleActiveSubagentRuns(
      'Daemon restarted or orchestrator re-enabled; subagent stopped and worktree preserved',
    );
    return settled.length;
  }

  /**
   * Called when `hm.plugin.multi-harness-orchestrator` is disabled or unloaded:
   * - Interrupts all active subagents across all parents
   * - Clears timeout timers & pending wakeup queues
   * - NEVER deletes any unmerged Worktree or branch!
   */
  async onPluginDisabled(): Promise<void> {
    for (const timer of this.subagentTimers.values()) {
      clearTimeout(timer);
    }
    this.subagentTimers.clear();
    this.pendingWakeupsByParent.clear();

    const reason = 'Orchestrator plugin disabled; worktree preserved for manual review';
    const active = this.store.listSubagentRuns({ statuses: ACTIVE_SUBAGENT_STATUSES });
    const now = Date.now();
    for (const run of active) {
      this.settlingChildren.add(run.childSessionId);
      const updated = this.store.updateSubagentRun(run.subagentId, {
        status: 'stopped',
        error: reason,
        finishedAt: now,
      }) ?? { ...run, status: 'stopped' as const, error: reason, finishedAt: now };
      this.hooks?.emitCanonical(run.parentSessionId, 'subagent.updated', {
        subagent: updated,
        reason,
      });
      this.syncTaskLedgerStep(run.parentSessionId, updated);
    }

    for (const run of active) {
      if (this.hooks) {
        await this.hooks.interruptSession(run.childSessionId).catch(() => {});
        const diffStat = await this.snapshotWorktreeAndDiffStat(run, `chore(subagent): snapshot before disable (${run.roleTitle})`).catch(() => null);
        if (diffStat) {
          this.store.updateSubagentRun(run.subagentId, { diffStat });
        }
      }
      this.settlingChildren.delete(run.childSessionId);
    }
  }

  // ── Internal Settlement & Cohort Wakeup Machinery ────────────────────

  private async handleChildTerminal(
    childSessionId: string,
    terminalStatus: 'completed' | 'failed' | 'stopped',
    errorMessage?: string | null,
  ): Promise<void> {
    if (this.settlingChildren.has(childSessionId)) return;
    const run = this.store.getSubagentRunByChildSession(childSessionId);
    if (!run || TERMINAL_SUBAGENT_STATUSES.has(run.status)) return;

    this.settlingChildren.add(childSessionId);
    this.clearSubagentTimer(run.subagentId);
    try {
      const diffStat = await this.snapshotWorktreeAndDiffStat(
        run,
        `chore(subagent): ${run.roleTitle} (${terminalStatus})`,
      );
      const summary = this.extractLatestAssistantSummary(childSessionId) ?? run.summary ?? null;
      const updated =
        this.store.updateSubagentRun(run.subagentId, {
          status: terminalStatus,
          summary,
          error: terminalStatus === 'completed' ? null : (errorMessage ?? run.error ?? null),
          diffStat,
          finishedAt: Date.now(),
        }) ?? run;

      this.hooks?.emitCanonical(run.parentSessionId, 'subagent.updated', {
        subagent: updated,
      });
      this.syncTaskLedgerStep(run.parentSessionId, updated);

      // Fail-fast policy: if this subagent failed with failFast=true, stop active siblings in the same cohort
      if (terminalStatus === 'failed' && updated.failFast) {
        const siblings = this.store.listSubagentRuns({
          cohortId: updated.cohortId,
          statuses: ACTIVE_SUBAGENT_STATUSES,
        });
        for (const sibling of siblings) {
          if (sibling.subagentId !== updated.subagentId) {
            await this.stopSubagent(
              sibling.subagentId,
              `Stopped by fail-fast policy after sibling "${updated.roleTitle}" failed`,
              { suppressWakeup: true },
            ).catch(() => {});
          }
        }
      }

      await this.evaluateCohortCompletion(updated.cohortId);
    } finally {
      this.settlingChildren.delete(childSessionId);
    }
  }

  private async evaluateCohortCompletion(cohortId: string): Promise<void> {
    const runs = this.store.listSubagentRuns({ cohortId });
    if (runs.length === 0) return;

    const allTerminal = runs.every((r) => TERMINAL_SUBAGENT_STATUSES.has(r.status));
    if (!allTerminal) return;
    if (this.deliveredCohorts.has(cohortId)) return;

    this.deliveredCohorts.add(cohortId);
    const parentSessionId = runs[0]!.parentSessionId;
    const parent = this.store.getSession(parentSessionId);
    if (!parent || parent.status === 'archived') return;

    const summaryMarkdown = this.buildCohortSummaryMarkdown(cohortId, runs);
    const completedCount = runs.filter((r) => r.status === 'completed').length;
    const failedCount = runs.filter((r) => r.status === 'failed').length;
    const stoppedCount = runs.filter((r) => r.status === 'stopped').length;

    // 1. Write structured `ext:orchestrator.cohort` block & emit `subagent.cohort_completed`
    this.upsertCohortBlock(parentSessionId, cohortId, summaryMarkdown);
    this.hooks?.emitCanonical(parentSessionId, 'subagent.cohort_completed', {
      cohortId,
      parentSessionId,
      total: runs.length,
      completedCount,
      failedCount,
      stoppedCount,
      subagents: runs,
      summaryMarkdown,
    });

    this.hooks?.publishAttention({
      kind: 'session_updated',
      sessionId: parentSessionId,
      sessionTitle: parent.title,
      harnessId: parent.harnessId,
      summary: `并行协作批次 ${cohortId} 完成（${completedCount}/${runs.length} 成功）`,
      timestamp: Date.now(),
    });

    const entry: PendingWakeupEntry = {
      cohortId,
      summaryMarkdown,
      subagents: runs,
      createdAt: Date.now(),
    };

    // 2. Completion Cohort Wakeup Queue:
    // If parent is currently busy (running / awaiting_approval), queue wakeup until parent is idle!
    const freshParent = this.store.getSession(parentSessionId);
    if (!freshParent || freshParent.status === 'archived') return;

    if (freshParent.status === 'running' || freshParent.status === 'awaiting_approval') {
      const queue = this.pendingWakeupsByParent.get(parentSessionId) ?? [];
      const existingIdx = queue.findIndex((q) => q.cohortId === cohortId);
      if (existingIdx >= 0) queue[existingIdx] = entry;
      else queue.push(entry);
      this.pendingWakeupsByParent.set(parentSessionId, queue);
      return;
    }

    if (freshParent.status === 'idle') {
      const queue = this.pendingWakeupsByParent.get(parentSessionId) ?? [];
      queue.push(entry);
      this.pendingWakeupsByParent.set(parentSessionId, queue);
      await this.drainPendingWakeups(parentSessionId);
    }
  }

  private async drainPendingWakeups(parentSessionId: string): Promise<void> {
    const queue = this.pendingWakeupsByParent.get(parentSessionId);
    if (!queue || queue.length === 0) return;

    const parent = this.store.getSession(parentSessionId);
    if (!parent || parent.status !== 'idle') return;
    if (!this.hooks?.isOrchestratorEnabled()) {
      this.pendingWakeupsByParent.delete(parentSessionId);
      return;
    }

    // Consumer AGY provenance guard: do not auto-inject orchestrator wakeup turns into consumer OAuth AGY sessions
    const parentAdapter = this.registry.get(parent.harnessId);
    const parentDriverId = parentAdapter?.driverId ?? parentAdapter?.kind ?? parent.harnessKind;
    const wakeupProvenance = evaluateAgyConsumerProvenance(
      {
        instanceId: parent.harnessId,
        driverId: parentDriverId,
        profile: parentAdapter instanceof AgyAdapter ? parentAdapter.getProfile() : null,
      },
      mintAgyDispatchProvenance('hm_orchestrator_wakeup', 'system', 'orchestrator.drainPendingWakeups'),
    );
    if (!wakeupProvenance.allowed) {
      this.pendingWakeupsByParent.delete(parentSessionId);
      return;
    }

    // Drain ALL queued cohorts into a SINGLE aggregated wakeup turn so parent is never spammed
    const batch = queue.splice(0, queue.length);
    this.pendingWakeupsByParent.delete(parentSessionId);

    const aggregatedPrompt =
      batch.length === 1
        ? `[Orchestrator Cohort Wakeup · ${batch[0]!.cohortId}]\nAll parallel subagents in this cohort have finished. Review the aggregated results below and decide next steps (note: worktree branches are NOT auto-merged; human confirmation is required before merge-back).\n\n${batch[0]!.summaryMarkdown}`
        : `[Orchestrator Aggregated Wakeup · ${batch.length} Cohorts]\nMultiple parallel subagent cohorts finished while you were busy. Review the combined results below:\n\n${batch.map((b) => b.summaryMarkdown).join('\n\n---\n\n')}`;

    this.wakeupDeliveriesByParent.set(
      parentSessionId,
      (this.wakeupDeliveriesByParent.get(parentSessionId) ?? 0) + 1,
    );

    try {
      await this.hooks.sendTurn(parentSessionId, aggregatedPrompt, {
        omitHandoff: true,
        literalText: true,
      });
    } catch {
      // Never crash daemon if parent cannot accept wakeup turn
    }
  }

  private upsertCohortBlock(
    parentSessionId: string,
    cohortId: string,
    summaryMarkdown?: string,
  ): void {
    const parent = this.store.getSession(parentSessionId);
    if (!parent) return;
    const runs = this.store.listSubagentRuns({ cohortId });
    if (runs.length === 0) return;

    const completedCount = runs.filter((r) => r.status === 'completed').length;
    const failedCount = runs.filter((r) => r.status === 'failed').length;
    const stoppedCount = runs.filter((r) => r.status === 'stopped').length;
    const runningCount = runs.filter((r) => ACTIVE_SUBAGENT_STATUSES.includes(r.status)).length;
    const now = Date.now();
    const itemId = `orchestrator:cohort:${cohortId}`;
    const existing = this.store.getTurnItem(itemId);
    const md = summaryMarkdown ?? this.buildCohortSummaryMarkdown(cohortId, runs);

    this.store.upsertTurnItem({
      itemId,
      schemaVersion: 2,
      sessionId: parentSessionId,
      turnId: existing?.turnId ?? null,
      seq: existing?.seq ?? Math.max(1, parent.lastSeq),
      instanceId: parent.harnessId,
      driverId: parent.harnessKind,
      blockType: 'ext:orchestrator.cohort',
      status: runningCount > 0 ? 'running' : failedCount === runs.length ? 'failed' : 'completed',
      title: `并行协作批次 · ${completedCount}/${runs.length} 完成`,
      textBody: md,
      payload: {
        cohortId,
        parentSessionId,
        total: runs.length,
        completedCount,
        failedCount,
        stoppedCount,
        runningCount,
        subagents: runs.map((r) => ({
          subagentId: r.subagentId,
          childSessionId: r.childSessionId,
          targetInstanceId: r.targetInstanceId,
          targetDriverId: r.targetDriverId ?? null,
          roleTitle: r.roleTitle,
          isolation: r.isolation,
          branchName: r.branchName ?? null,
          baseBranch: r.baseBranch ?? null,
          worktreePath: r.worktreePath ?? null,
          effectiveApprovalPolicy: r.effectiveApprovalPolicy,
          status: r.status,
          diffStat: r.diffStat ?? null,
          summary: r.summary ?? null,
          error: r.error ?? null,
          mergedAt: r.mergedAt ?? null,
          mergedIntoBranch: r.mergedIntoBranch ?? null,
          worktreeCleaned: Boolean(r.worktreeCleaned),
        })),
      },
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private buildCohortSummaryMarkdown(cohortId: string, runs: SubagentRunRecord[]): string {
    const lines: string[] = [
      `### 并行协作批次汇总 (${cohortId})`,
      '',
      '| 角色 | 引擎实例 | 隔离模式 | 状态 | 分支 / 变更统计 | 摘要 |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const r of runs) {
      const diffText = r.diffStat
        ? `${r.branchName ?? '-'} (+${r.diffStat.insertions} -${r.diffStat.deletions}, ${r.diffStat.filesChanged} files)`
        : r.branchName ?? 'read_only';
      const summaryCell = (r.summary || r.error || '-').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').slice(0, 140);
      lines.push(
        `| ${r.roleTitle.replace(/\|/g, '\\|')} | ${r.targetInstanceId} | ${r.isolation} | ${r.status} | ${diffText} | ${summaryCell} |`,
      );
    }
    return lines.join('\n');
  }

  private async snapshotWorktreeAndDiffStat(
    run: SubagentRunRecord,
    commitMessage: string,
  ): Promise<SubagentDiffStat | null> {
    if (run.isolation !== 'worktree_write' || !run.worktreePath || !run.branchName) {
      return run.diffStat ?? null;
    }
    const git = this.hooks?.getGitService();
    const parent = this.store.getSession(run.parentSessionId);
    const workspace = parent ? this.store.getWorkspace(parent.workspaceId) : null;
    if (!git || !workspace) return run.diffStat ?? null;

    try {
      await git.commitWorktreeChangesIfDirty(run.worktreePath, commitMessage);
      const baseBranch = run.baseBranch || (await git.inspect(workspace.rootPath)).branch || 'main';
      return await git.computeBranchDiffStat(workspace.rootPath, baseBranch, run.branchName);
    } catch {
      return run.diffStat ?? null;
    }
  }

  private extractLatestAssistantSummary(childSessionId: string): string | null {
    const items = this.store.listTurnItems(childSessionId, {
      blockTypes: ['assistant_text'],
      limit: 50,
    });
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const text = items[i]?.textBody?.trim();
      if (text) return text.slice(0, 1500);
    }
    const events = this.store.getEventsAfter(childSessionId, 0, 200);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]!;
      if (ev.type === 'message.assistant.completed' && typeof ev.payload.text === 'string') {
        const text = ev.payload.text.trim();
        if (text) return text.slice(0, 1500);
      }
    }
    return null;
  }

  private syncTaskLedgerStep(parentSessionId: string, run: SubagentRunRecord): void {
    const ledger = this.hooks?.getTaskLedger();
    const parent = this.store.getSession(parentSessionId);
    if (!ledger || !parent) return;
    try {
      const state = ledger.getOrCreate(parent);
      const stepId = `subagent:${run.subagentId}`;
      const mappedStatus: 'pending' | 'in_progress' | 'done' | 'blocked' =
        run.status === 'completed'
          ? 'done'
          : run.status === 'failed' || run.status === 'awaiting_approval'
            ? 'blocked'
            : run.status === 'stopped'
              ? 'pending'
              : 'in_progress';
      const title = `[${run.targetInstanceId}] ${run.roleTitle}${run.branchName ? ` (${run.branchName})` : ''}`;
      const existingSteps = [...state.steps];
      const idx = existingSteps.findIndex((s) => s.id === stepId);
      const nextStep = {
        id: stepId,
        title,
        status: mappedStatus,
        ownerHarnessId: run.targetInstanceId,
        updatedAt: Date.now(),
      };
      if (idx >= 0) existingSteps[idx] = nextStep;
      else existingSteps.push(nextStep);
      ledger.updateManual(parent, { steps: existingSteps });
    } catch {
      // Optional ledger integration must never fail orchestration
    }
  }

  private armSubagentTimer(subagentId: string, timeoutMs: number): void {
    this.clearSubagentTimer(subagentId);
    const timer = setTimeout(() => {
      this.subagentTimers.delete(subagentId);
      void this.stopSubagent(subagentId, `Subagent execution timed out after ${timeoutMs}ms`).catch(() => {});
    }, timeoutMs);
    timer.unref?.();
    this.subagentTimers.set(subagentId, timer);
  }

  private clearSubagentTimer(subagentId: string): void {
    const existing = this.subagentTimers.get(subagentId);
    if (existing) {
      clearTimeout(existing);
      this.subagentTimers.delete(subagentId);
    }
  }
}
