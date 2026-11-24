import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ApprovalDecision,
  HarnessCapabilities,
  HarnessCapabilitiesV2,
  HarnessInfo,
  PermissionMode,
} from '@harnessmate/protocol';
import {
  ORCHESTRATOR_PLUGIN_ID,
  OrchestratorError,
  capApprovalPolicy,
} from '../src/core/orchestrator-service.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NormalizedAdapterEvent,
  TurnInput,
} from '../src/harnesses/types.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const tempDirs: string[] = [];
const activeDaemons: DaemonInstance[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gitSync(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initTempGitRepo(prefix = 'hm-orch-repo-'): string {
  const dir = makeTempDir(prefix);
  gitSync(dir, ['init', '-b', 'main']);
  gitSync(dir, ['config', 'core.autocrlf', 'false']);
  gitSync(dir, ['config', 'user.email', 'test@harnessmate.local']);
  gitSync(dir, ['config', 'user.name', 'HarnessMate Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Orchestrator Repo\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'shared.ts'), 'export const SHARED_LINE = "v0";\n', 'utf8');
  gitSync(dir, ['add', '.']);
  gitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 12_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
  }
}

interface RecordedSession {
  config: AdapterSessionConfig;
  turns: TurnInput[];
  interrupted: boolean;
  disposed: boolean;
  emit: (ev: NormalizedAdapterEvent) => void;
}

/**
 * Controllable multi-engine mock adapter supporting manual turn completion,
 * isolated file writes inside `config.cwd`, approval requests, and MCP lease inspection.
 */
class OrchestratorMockAdapter implements HarnessAdapter {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly description = 'Orchestrator mock adapter';
  readonly protocolLabel = 'mock-orch';
  readonly pluginMcpTransport = 'http' as const;
  readonly capabilities: HarnessCapabilities;
  readonly capabilitiesV2: HarnessCapabilitiesV2;

  readonly sessions: RecordedSession[] = [];
  private readonly onTurnHook?: (rec: RecordedSession, input: TurnInput) => Promise<void> | void;

  constructor(opts: {
    id: string;
    kind?: string;
    onTurn?: (rec: RecordedSession, input: TurnInput) => Promise<void> | void;
  }) {
    this.id = opts.id;
    this.kind = opts.kind ?? opts.id;
    this.displayName = `Mock ${opts.id}`;
    this.onTurnHook = opts.onTurn;
    this.capabilities = {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['medium', 'high'],
      permissionModes: ['plan', 'manual', 'accept_edits', 'auto'],
      sessionResume: true,
      sessionFork: false,
      imageInput: false,
      subagents: true,
    };
    this.capabilitiesV2 = {
      ...this.capabilities,
      transport: 'custom',
      historyInjectionMode: 'inline',
      supportsNativeRollback: false,
      supportsNativeFork: false,
      supportsActiveSteering: false,
      supportsUsageLimits: false,
      supportsDynamicOptions: false,
      supportedApprovalDecisions: ['allow_once', 'allow_session', 'deny'],
      nativeCommands: [],
      optionDescriptors: [],
    };
  }

  async probe(): Promise<HarnessInfo> {
    return {
      id: this.id,
      kind: this.kind,
      driverId: this.kind,
      instanceId: this.id,
      displayName: this.displayName,
      description: this.description,
      protocolLabel: this.protocolLabel,
      binaryPath: null,
      version: '1.0.0-test',
      health: 'ready',
      capabilities: this.capabilities,
      capabilitiesV2: this.capabilitiesV2,
      models: [{ id: `${this.id}-default`, displayName: `${this.id} Default`, isDefault: true }],
      defaultModelId: `${this.id}-default`,
    };
  }

  async createSession(config: AdapterSessionConfig): Promise<AdapterSessionHandle> {
    const listeners = new Set<(ev: NormalizedAdapterEvent) => void>();
    const rec: RecordedSession = {
      config,
      turns: [],
      interrupted: false,
      disposed: false,
      emit: (ev) => {
        for (const l of [...listeners]) l(ev);
      },
    };
    this.sessions.push(rec);

    const nativeId = config.nativeSessionId ?? `nat_${this.id}_${crypto.randomBytes(3).toString('hex')}`;
    return {
      nativeSessionId: nativeId,
      pluginMcpAvailable: Boolean(config.pluginMcp),
      sendTurn: async (input: TurnInput) => {
        rec.turns.push(input);
        rec.emit({ type: 'turn.started', turnId: input.turnId });
        if (this.onTurnHook) {
          await this.onTurnHook(rec, input);
          return;
        }
        // Default: stay pending if prompt includes __HOLD__, else emit immediate completion
        if (input.text.includes('__HOLD__')) {
          return;
        }
        if (input.text.includes('__APPROVAL__')) {
          rec.emit({
            type: 'approval.requested',
            turnId: input.turnId,
            nativeRequestId: `nat_appr_${input.turnId}`,
            kind: 'command_approval',
            toolName: 'bash',
            toolKind: 'shell',
            summary: 'Run risky deploy command',
            input: { command: 'rm -rf ./dist' },
            riskLevel: 'high',
          });
          return;
        }
        rec.emit({
          type: 'message.assistant.completed',
          turnId: input.turnId,
          text: `[${this.id}] Completed in ${config.cwd}`,
        });
        rec.emit({ type: 'turn.completed', turnId: input.turnId });
      },
      interrupt: async () => {
        rec.interrupted = true;
      },
      resolveApproval: async (_nativeRequestId: string, _decision: ApprovalDecision) => {},
      dispose: async () => {
        rec.disposed = true;
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }
}

async function createTestDaemon(
  adapters: HarnessAdapter[],
  opts?: { dataDir?: string; enableOrchestrator?: boolean },
): Promise<DaemonInstance> {
  const dataDir = opts?.dataDir ?? makeTempDir('hm-orch-data-');
  const daemon = createDaemon({ dataDir, port: 0, customAdapters: adapters, webDistDir: null });
  await daemon.pluginManager.reloadAll();
  await daemon.app.ready();
  if (opts?.enableOrchestrator !== false) {
    await daemon.pluginManager.togglePlugin(ORCHESTRATOR_PLUGIN_ID, true);
  }
  activeDaemons.push(daemon);
  return daemon;
}

async function callMcp(
  daemon: DaemonInstance,
  token: string,
  method: string,
  params?: Record<string, unknown>,
) {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/v1/plugin-tools',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const d = activeDaemons.pop()!;
    try {
      await d.stop();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows transient handle release
    }
  }
});

describe('Phase 3.2 · Multi-Harness Parallel Orchestrator (Scenario D)', { timeout: 30_000 }, () => {
  it('enforces permission ceiling (No Privilege Escalation) at both unit and runtime levels', async () => {
    // Pure policy ceiling matrix
    expect(capApprovalPolicy('manual', 'auto')).toBe('manual');
    expect(capApprovalPolicy('manual', 'full_auto')).toBe('manual');
    expect(capApprovalPolicy('manual', 'accept_edits')).toBe('manual');
    expect(capApprovalPolicy('manual', 'plan')).toBe('plan'); // narrowing is allowed
    expect(capApprovalPolicy('plan', 'auto')).toBe('plan');
    expect(capApprovalPolicy('plan', 'manual')).toBe('plan');
    expect(capApprovalPolicy('accept_edits', 'auto')).toBe('accept_edits');
    expect(capApprovalPolicy('accept_edits', 'ask')).toBe('manual');
    expect(capApprovalPolicy('auto', 'auto')).toBe('auto');

    // Runtime verification: parent in `manual` mode spawns subagent requesting `full_auto`
    const repo = initTempGitRepo();
    const parentAdapter = new OrchestratorMockAdapter({ id: 'orch-parent' });
    const childAdapter = new OrchestratorMockAdapter({ id: 'orch-worker' });
    const daemon = await createTestDaemon([parentAdapter, childAdapter]);

    const ws = await daemon.sessionManager.addWorkspace(repo, 'ceiling-ws');
    const parent = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'orch-parent',
      permissionMode: 'manual' as PermissionMode,
    });

    const orch = daemon.sessionManager.getOrchestratorService();
    const run = await orch.delegateTask(parent.id, {
      targetInstanceId: 'orch-worker',
      roleTitle: 'Attempted Escalation Worker',
      prompt: 'Try to run in full_auto mode',
      isolation: 'read_only',
      requestedApprovalPolicy: 'full_auto',
    });

    expect(run.effectiveApprovalPolicy).toBe('manual');
    const childSession = daemon.store.getSession(run.childSessionId)!;
    expect(childSession.permissionMode).toBe('manual');
    expect(childSession.parentSessionId).toBe(parent.id);
    expect(childAdapter.sessions[0]!.config.permissionMode).toBe('manual');
  });

  it('rejects worktree_write 100% in non-Git workspaces with zero mutations, while allowing read_only', async () => {
    const nonGitDir = makeTempDir('hm-nongit-ws-');
    fs.writeFileSync(path.join(nonGitDir, 'notes.txt'), 'original-content\n', 'utf8');

    const parentAdapter = new OrchestratorMockAdapter({ id: 'orch-coord' });
    const workerAdapter = new OrchestratorMockAdapter({ id: 'orch-reviewer' });
    const daemon = await createTestDaemon([parentAdapter, workerAdapter]);

    const ws = await daemon.sessionManager.addWorkspace(nonGitDir, 'nongit-ws');
    const parent = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'orch-coord',
      permissionMode: 'accept_edits',
    });

    // Trigger a held parent turn so parent acquires its MCP lease
    await daemon.sessionManager.sendTurn(parent.id, '__HOLD__ coordinate');
    const mcpToken = parentAdapter.sessions[0]!.config.pluginMcp!.token;
    const filesBeforeDelegate = fs.readdirSync(nonGitDir);

    // 1. MCP hm_delegate_task with worktree_write -> 100% rejected
    const writeRes = await callMcp(daemon, mcpToken, 'tools/call', {
      name: 'hm_delegate_task',
      arguments: {
        targetInstanceId: 'orch-reviewer',
        roleTitle: 'Illegal Writer',
        prompt: 'Write code',
        isolation: 'worktree_write',
      },
    });
    expect(writeRes.body.result.isError).toBe(true);
    expect(writeRes.body.result.content[0].text).toContain('Write delegation requires a Git repository');

    // Zero mutations in non-Git directory & zero child sessions created
    expect(fs.readdirSync(nonGitDir)).toEqual(filesBeforeDelegate);
    expect(fs.readFileSync(path.join(nonGitDir, 'notes.txt'), 'utf8')).toBe('original-content\n');
    expect(daemon.store.listSubagentRuns({ parentSessionId: parent.id })).toHaveLength(0);

    // 2. MCP hm_delegate_task with read_only -> allowed & completes cleanly
    const readRes = await callMcp(daemon, mcpToken, 'tools/call', {
      name: 'hm_delegate_task',
      arguments: {
        targetInstanceId: 'orch-reviewer',
        roleTitle: 'Read-Only Reviewer',
        prompt: 'Inspect notes.txt',
        isolation: 'read_only',
      },
    });
    expect(readRes.body.result.isError).toBeUndefined();
    const parsed = JSON.parse(readRes.body.result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.subagent.isolation).toBe('read_only');
    expect(parsed.subagent.worktreePath).toBeNull();
  });

  it('enforces maxDepth = 1 recursion guard and maxConcurrent = 4 pool limit', async () => {
    const repo = initTempGitRepo();
    const adapter = new OrchestratorMockAdapter({ id: 'orch-eng' });
    const daemon = await createTestDaemon([adapter]);

    const ws = await daemon.sessionManager.addWorkspace(repo, 'limits-ws');
    const parent = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'orch-eng',
      permissionMode: 'accept_edits',
    });

    const orch = daemon.sessionManager.getOrchestratorService();

    // Spawn 4 active held subagents -> all 4 succeed
    const spawned = [];
    for (let i = 1; i <= 4; i += 1) {
      const sub = await orch.delegateTask(parent.id, {
        targetInstanceId: 'orch-eng',
        roleTitle: `Worker ${i}`,
        prompt: `__HOLD__ task ${i}`,
        isolation: 'read_only',
      });
      spawned.push(sub);
    }
    expect(orch.getBoard(parent.id).activeCount).toBe(4);

    // 5th concurrent subagent -> hard intercepted
    await expect(
      orch.delegateTask(parent.id, {
        targetInstanceId: 'orch-eng',
        roleTitle: 'Worker 5 Overflow',
        prompt: '__HOLD__ overflow',
        isolation: 'read_only',
      }),
    ).rejects.toMatchObject({ code: 'E_MAX_CONCURRENT_EXCEEDED' });

    // Recursion guard: child at depth 1 tries to spawn grandchild (depth 2 > maxDepth 1) -> hard intercepted
    await expect(
      orch.delegateTask(spawned[0]!.childSessionId, {
        targetInstanceId: 'orch-eng',
        roleTitle: 'Grandchild Attempt',
        prompt: 'Recurse!',
        isolation: 'read_only',
      }),
    ).rejects.toMatchObject({ code: 'E_MAX_DEPTH_EXCEEDED' });

    // Stopping one frees a concurrency slot
    await orch.stopSubagent(spawned[0]!.subagentId);
    expect(orch.getBoard(parent.id).activeCount).toBe(3);

    const replacement = await orch.delegateTask(parent.id, {
      targetInstanceId: 'orch-eng',
      roleTitle: 'Worker 5 Replacement',
      prompt: 'Quick done',
      isolation: 'read_only',
    });
    expect(replacement.subagentId).toBeTruthy();
  });

  it('queues out-of-order cohort completions while parent is busy and delivers exactly 1 aggregated wakeup when parent becomes idle', async () => {
    const repo = initTempGitRepo();
    const parentAdapter = new OrchestratorMockAdapter({ id: 'orch-lead' });
    const engA = new OrchestratorMockAdapter({ id: 'eng-a' });
    const engB = new OrchestratorMockAdapter({ id: 'eng-b' });
    const engC = new OrchestratorMockAdapter({ id: 'eng-c' });
    const daemon = await createTestDaemon([parentAdapter, engA, engB, engC]);

    const ws = await daemon.sessionManager.addWorkspace(repo, 'cohort-ws');
    const parent = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'orch-lead',
      permissionMode: 'accept_edits',
    });

    // Parent enters busy `running` state
    const parentTurn = await daemon.sessionManager.sendTurn(parent.id, '__HOLD__ orchestrate 3 engines');
    expect(daemon.store.getSession(parent.id)!.status).toBe('running');
    expect(parentAdapter.sessions[0]!.turns).toHaveLength(1);

    const orch = daemon.sessionManager.getOrchestratorService();
    const cohortId = 'cohort_out_of_order';

    const sub1 = await orch.delegateTask(parent.id, {
      targetInstanceId: 'eng-a',
      roleTitle: 'API Engineer',
      prompt: '__HOLD__ build API',
      isolation: 'read_only',
      cohortId,
    });
    const sub2 = await orch.delegateTask(parent.id, {
      targetInstanceId: 'eng-b',
      roleTitle: 'Test Engineer',
      prompt: '__HOLD__ write tests',
      isolation: 'read_only',
      cohortId,
    });
    const sub3 = await orch.delegateTask(parent.id, {
      targetInstanceId: 'eng-c',
      roleTitle: 'Security Reviewer',
      prompt: '__HOLD__ audit code',
      isolation: 'read_only',
      cohortId,
    });

    // Finish subagents OUT OF ORDER: #3 -> #1 -> #2 while parent is STILL running
    const finishWorker = (adapter: OrchestratorMockAdapter, text: string) => {
      const rec = adapter.sessions[0]!;
      const tid = rec.turns[0]!.turnId;
      rec.emit({ type: 'message.assistant.completed', turnId: tid, text });
      rec.emit({ type: 'turn.completed', turnId: tid });
    };

    finishWorker(engC, 'Audit clean: 0 critical findings');
    await waitForCondition(() => daemon.store.getSubagentRun(sub3.subagentId)!.status === 'completed');
    finishWorker(engA, 'API endpoint /v1/items implemented');
    await waitForCondition(() => daemon.store.getSubagentRun(sub1.subagentId)!.status === 'completed');
    finishWorker(engB, 'Unit tests 12/12 passed');
    await waitForCondition(() => daemon.store.getSubagentRun(sub2.subagentId)!.status === 'completed');

    // Cohort block is materialized on parent, but parent has NOT been interrupted while running!
    await waitForCondition(() =>
      daemon.store.listTurnItems(parent.id, { blockTypes: ['ext:orchestrator.cohort'] }).length === 1,
    );
    expect(orch.getWakeupCount(parent.id)).toBe(0);
    expect(parentAdapter.sessions[0]!.turns).toHaveLength(1);
    const boardWhileBusy = orch.getBoard(parent.id);
    expect(boardWhileBusy.cohorts[0]!.wakeupQueued).toBe(true);

    // Parent finishes its active turn -> transitions to idle -> triggers EXACTLY ONE aggregated wakeup!
    parentAdapter.sessions[0]!.emit({
      type: 'message.assistant.completed',
      turnId: parentTurn.turnId,
      text: 'Standing by for cohort results',
    });
    parentAdapter.sessions[0]!.emit({ type: 'turn.completed', turnId: parentTurn.turnId });

    await waitForCondition(() => parentAdapter.sessions[0]!.turns.length === 2);
    // Give any stray microtasks a moment to prove no duplicate wakeup occurs
    await new Promise((r) => setTimeout(r, 80));

    expect(orch.getWakeupCount(parent.id)).toBe(1);
    expect(parentAdapter.sessions[0]!.turns).toHaveLength(2);
    const wakeupPrompt = parentAdapter.sessions[0]!.turns[1]!.text;
    expect(wakeupPrompt).toContain(cohortId);
    expect(wakeupPrompt).toContain('API Engineer');
    expect(wakeupPrompt).toContain('Test Engineer');
    expect(wakeupPrompt).toContain('Security Reviewer');
  });

  it('executes real Git worktree isolation, dry-run conflict detection (clean & conflicting), explicit merge-back & safe worktree cleanup', async () => {
    const repo = initTempGitRepo('hm-e2e-orch-');
    const leadAdapter = new OrchestratorMockAdapter({ id: 'lead-codex' });
    const backendAdapter = new OrchestratorMockAdapter({
      id: 'worker-backend',
      onTurn: (rec, input) => {
        fs.writeFileSync(path.join(rec.config.cwd, 'backend.ts'), 'export const api = "ready";\n', 'utf8');
        fs.writeFileSync(path.join(rec.config.cwd, 'shared.ts'), 'export const SHARED_LINE = "backend-v1";\n', 'utf8');
        rec.emit({ type: 'message.assistant.completed', turnId: input.turnId, text: 'Implemented backend.ts & updated shared.ts' });
        rec.emit({ type: 'turn.completed', turnId: input.turnId });
      },
    });
    const testAdapter = new OrchestratorMockAdapter({
      id: 'worker-tests',
      onTurn: (rec, input) => {
        fs.writeFileSync(path.join(rec.config.cwd, 'feature.test.ts'), 'export const passed = true;\n', 'utf8');
        rec.emit({ type: 'message.assistant.completed', turnId: input.turnId, text: 'Added feature.test.ts' });
        rec.emit({ type: 'turn.completed', turnId: input.turnId });
      },
    });
    const conflictAdapter = new OrchestratorMockAdapter({
      id: 'worker-conflict',
      onTurn: (rec, input) => {
        fs.writeFileSync(path.join(rec.config.cwd, 'shared.ts'), 'export const SHARED_LINE = "conflicting-v2";\n', 'utf8');
        rec.emit({ type: 'message.assistant.completed', turnId: input.turnId, text: 'Edited shared.ts independently' });
        rec.emit({ type: 'turn.completed', turnId: input.turnId });
      },
    });

    const daemon = await createTestDaemon([leadAdapter, backendAdapter, testAdapter, conflictAdapter]);
    const ws = await daemon.sessionManager.addWorkspace(repo, 'e2e-git-ws');
    const parent = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'lead-codex',
      permissionMode: 'accept_edits',
    });

    const orch = daemon.sessionManager.getOrchestratorService();

    // Concurrently delegate 2 distinct-engine writable subagents + 1 conflicting subagent
    const [subBackend, subTests, subConflict] = await Promise.all([
      orch.delegateTask(parent.id, {
        targetInstanceId: 'worker-backend',
        roleTitle: 'Backend API',
        prompt: 'Implement backend.ts',
        isolation: 'worktree_write',
        cohortId: 'cohort_e2e',
      }),
      orch.delegateTask(parent.id, {
        targetInstanceId: 'worker-tests',
        roleTitle: 'Unit Tests',
        prompt: 'Write feature.test.ts',
        isolation: 'worktree_write',
        cohortId: 'cohort_e2e',
      }),
      orch.delegateTask(parent.id, {
        targetInstanceId: 'worker-conflict',
        roleTitle: 'Conflicting Editor',
        prompt: 'Modify shared.ts',
        isolation: 'worktree_write',
        cohortId: 'cohort_e2e',
      }),
    ]);

    await waitForCondition(
      () =>
        daemon.store.getSubagentRun(subBackend.subagentId)!.status === 'completed' &&
        daemon.store.getSubagentRun(subTests.subagentId)!.status === 'completed' &&
        daemon.store.getSubagentRun(subConflict.subagentId)!.status === 'completed',
    );

    // Physical Worktree isolation verification: main repo untouched, children don't cross-contaminate
    expect(fs.existsSync(path.join(repo, 'backend.ts'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'feature.test.ts'))).toBe(false);
    expect(fs.existsSync(path.join(subBackend.worktreePath!, 'backend.ts'))).toBe(true);
    expect(fs.existsSync(path.join(subBackend.worktreePath!, 'feature.test.ts'))).toBe(false);
    expect(fs.existsSync(path.join(subTests.worktreePath!, 'feature.test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(subTests.worktreePath!, 'backend.ts'))).toBe(false);

    // Auto-merge prohibited without explicit confirmMerge: true
    await expect(
      orch.mergeBackSubagent(subBackend.subagentId, {
        confirmMerge: false,
        cleanupWorktree: false,
        deleteBranch: false,
      }),
    ).rejects.toMatchObject({ code: 'E_CONFIRMATION_REQUIRED' });

    // 1. Clean dry-run & explicit confirmed merge-back for Backend subagent (with cleanup)
    const dryBackend = await orch.dryRunMergeSubagent(subBackend.subagentId);
    expect(dryBackend.dryRun.supported).toBe(true);
    expect(dryBackend.dryRun.hasConflicts).toBe(false);
    expect(dryBackend.diffStat.filesChanged).toBe(2);

    const mergedBackend = await orch.mergeBackSubagent(subBackend.subagentId, {
      confirmMerge: true,
      cleanupWorktree: true,
      deleteBranch: true,
    });
    expect(mergedBackend.merged).toBe(true);
    expect(mergedBackend.worktreeCleaned).toBe(true);
    expect(mergedBackend.branchDeleted).toBe(true);
    expect(fs.existsSync(path.join(repo, 'backend.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'shared.ts'), 'utf8')).toContain('backend-v1');
    expect(fs.existsSync(subBackend.worktreePath!)).toBe(false);

    // 2. Clean dry-run & explicit confirmed merge-back for Tests subagent
    const dryTests = await orch.dryRunMergeSubagent(subTests.subagentId);
    expect(dryTests.dryRun.hasConflicts).toBe(false);
    const mergedTests = await orch.mergeBackSubagent(subTests.subagentId, {
      confirmMerge: true,
      cleanupWorktree: true,
      deleteBranch: true,
    });
    expect(mergedTests.merged).toBe(true);
    expect(fs.existsSync(path.join(repo, 'feature.test.ts'))).toBe(true);

    // 3. Conflicting subagent -> dryRunMerge detects conflict on shared.ts, merge-back blocked, main repo stays clean!
    const dryConflict = await orch.dryRunMergeSubagent(subConflict.subagentId);
    expect(dryConflict.dryRun.hasConflicts).toBe(true);
    expect(dryConflict.dryRun.conflictFiles).toContain('shared.ts');

    let conflictErr: unknown;
    try {
      await orch.mergeBackSubagent(subConflict.subagentId, {
        confirmMerge: true,
        cleanupWorktree: false,
        deleteBranch: false,
      });
    } catch (err) {
      conflictErr = err;
    }
    expect(conflictErr).toBeInstanceOf(OrchestratorError);
    expect((conflictErr as OrchestratorError).code).toBe('E_MERGE_CONFLICT');
    expect((conflictErr as OrchestratorError).conflictFiles).toContain('shared.ts');

    // Main workspace is 100% unpolluted after conflict block (no modified/conflicted source files, no MERGE_HEAD)
    expect(gitSync(repo, ['status', '--porcelain', '--', '.', ':!.harnessmate'])).toBe('');
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'shared.ts'), 'utf8')).toContain('backend-v1');
  });

  it('propagates child approvals with parentSessionId, enforces timeout & crash/disable worktree preservation, conditional MCP exposure, and zero handoff regression', async () => {
    const repo = initTempGitRepo('hm-lifecycle-orch-');
    const dataDir = makeTempDir('hm-lifecycle-data-');
    const engA = new OrchestratorMockAdapter({ id: 'eng-alpha' });
    const engB = new OrchestratorMockAdapter({ id: 'eng-beta' });

    // Start with orchestrator DISABLED (default optional state) -> verify zero MCP tool leakage
    let daemon = await createTestDaemon([engA, engB], { dataDir, enableOrchestrator: false });
    const ws = await daemon.sessionManager.addWorkspace(repo, 'lifecycle-ws');
    const parent = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'eng-alpha',
      permissionMode: 'manual',
    });

    // Disabled by default: MCP lease not polluted, direct REST delegate rejected with 409
    const disabledPost = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${parent.id}/subagents`,
      payload: {
        targetInstanceId: 'eng-beta',
        roleTitle: 'Blocked While Disabled',
        prompt: 'Hi',
        isolation: 'read_only',
      },
    });
    expect(disabledPost.statusCode).toBe(409);

    // Enable orchestrator -> verify all 5 MCP tools appear in tools/list
    await daemon.pluginManager.togglePlugin(ORCHESTRATOR_PLUGIN_ID, true);
    const parentTurn = await daemon.sessionManager.sendTurn(parent.id, '__HOLD__ inspect tools');
    const token = engA.sessions[0]!.config.pluginMcp!.token;
    const listRes = await callMcp(daemon, token, 'tools/list');
    const toolNames = listRes.body.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'hm_delegate_task',
        'hm_list_subagents',
        'hm_get_subagent_result',
        'hm_send_to_subagent',
        'hm_stop_subagent',
      ]),
    );
    engA.sessions[0]!.emit({ type: 'turn.cancelled', turnId: parentTurn.turnId });

    const orch = daemon.sessionManager.getOrchestratorService();

    // 1. Child approval propagates with parentSessionId to global approval center
    const approvalSub = await orch.delegateTask(parent.id, {
      targetInstanceId: 'eng-beta',
      roleTitle: 'Approval Trigger',
      prompt: '__APPROVAL__ run risky command',
      isolation: 'read_only',
    });
    await waitForCondition(() => daemon.store.listPendingApprovals(approvalSub.childSessionId).length === 1);
    const globalPending = daemon.sessionManager.listPendingApprovals();
    const childApproval = globalPending.find((a) => a.sessionId === approvalSub.childSessionId);
    expect(childApproval).toBeDefined();
    expect(childApproval!.parentSessionId).toBe(parent.id);
    expect(daemon.store.getSubagentRun(approvalSub.subagentId)!.status).toBe('awaiting_approval');

    // 2. Timeout circuit breaker stops runaway subagent while preserving its Worktree branch
    const timeoutSub = await orch.delegateTask(parent.id, {
      targetInstanceId: 'eng-beta',
      roleTitle: 'Timeout Worker',
      prompt: '__HOLD__ slow task',
      isolation: 'worktree_write',
      timeoutMs: 250,
    });
    fs.writeFileSync(path.join(timeoutSub.worktreePath!, 'wip.ts'), 'export const wip = 1;\n', 'utf8');
    await waitForCondition(
      () => daemon.store.getSubagentRun(timeoutSub.subagentId)!.status === 'stopped',
      3000,
    );
    expect(fs.existsSync(timeoutSub.worktreePath!)).toBe(true);
    expect(gitSync(repo, ['branch', '--list', timeoutSub.branchName!])).toContain(timeoutSub.branchName!);

    // 3. Disabling plugin interrupts running subagents, removes MCP tools, and PRESERVES unmerged Worktree!
    const runningBeforeDisable = await orch.delegateTask(parent.id, {
      targetInstanceId: 'eng-beta',
      roleTitle: 'Preserved On Disable',
      prompt: '__HOLD__ active work',
      isolation: 'worktree_write',
    });
    fs.writeFileSync(path.join(runningBeforeDisable.worktreePath!, 'keep.ts'), 'export const keep = true;\n', 'utf8');

    await daemon.pluginManager.togglePlugin(ORCHESTRATOR_PLUGIN_ID, false);
    await waitForCondition(
      () => daemon.store.getSubagentRun(runningBeforeDisable.subagentId)!.status === 'stopped',
    );
    expect(fs.existsSync(runningBeforeDisable.worktreePath!)).toBe(true);
    expect(fs.existsSync(path.join(runningBeforeDisable.worktreePath!, 'keep.ts'))).toBe(true);
    expect(gitSync(repo, ['branch', '--list', runningBeforeDisable.branchName!])).toContain(
      runningBeforeDisable.branchName!,
    );

    // 4. Re-enable & simulate daemon crash/restart recovery -> orphaned active subagent converges to stopped, 0 worktree loss
    await daemon.pluginManager.togglePlugin(ORCHESTRATOR_PLUGIN_ID, true);
    const orchAfterReenable = daemon.sessionManager.getOrchestratorService();
    const crashSub = await orchAfterReenable.delegateTask(parent.id, {
      targetInstanceId: 'eng-beta',
      roleTitle: 'Orphan Crash Worker',
      prompt: '__HOLD__ running when daemon crashes',
      isolation: 'worktree_write',
    });
    fs.writeFileSync(path.join(crashSub.worktreePath!, 'survived.ts'), 'export const survived = true;\n', 'utf8');

    // Stop daemon and restart against the same dataDir
    await daemon.stop();
    activeDaemons.pop();
    const engA2 = new OrchestratorMockAdapter({ id: 'eng-alpha' });
    const engB2 = new OrchestratorMockAdapter({ id: 'eng-beta' });
    daemon = await createTestDaemon([engA2, engB2], { dataDir, enableOrchestrator: true });

    const recovered = daemon.store.getSubagentRun(crashSub.subagentId)!;
    expect(recovered.status).toBe('stopped');
    expect(recovered.finishedAt).toBeTypeOf('number');
    expect(fs.existsSync(crashSub.worktreePath!)).toBe(true);
    expect(fs.existsSync(path.join(crashSub.worktreePath!, 'survived.ts'))).toBe(true);
    expect(gitSync(repo, ['branch', '--list', crashSub.branchName!])).toContain(crashSub.branchName!);

    // 5. Serial single-session context-handoff remains 100% unaffected
    const serialSession = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'eng-alpha',
      permissionMode: 'accept_edits',
    });
    await daemon.sessionManager.sendTurn(serialSession.id, 'Hello from alpha');
    const switched = await daemon.sessionManager.switchHarness(serialSession.id, {
      targetHarnessId: 'eng-beta',
    });
    expect(switched.session.harnessId).toBe('eng-beta');
    expect(switched.session.participatingHarnesses).toEqual(expect.arrayContaining(['eng-alpha', 'eng-beta']));
    await daemon.sessionManager.sendTurn(serialSession.id, 'Continue on beta');
    expect(engB2.sessions.some((s) => s.turns.some((t) => t.text.includes('Continue on beta')))).toBe(true);
  });
});
