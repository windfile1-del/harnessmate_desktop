import type {
  ApprovalRequest,
  GitDryRunMergeResult,
  HarnessInfo,
  OrchestratorBoardResponse,
  Session,
  SubagentDiffStat,
  SubagentRunRecord,
} from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  MergeBackReviewModalView,
  OrchestratorCohortBlockCard,
  ParallelExecutionBoardView,
} from '../src/components/OrchestratorBoard';
import type { ExtensionTurnBlock } from '../src/lib/work-groups';
import { SlotRegistry, SlotRegistryProvider } from '../src/slots';

const sampleHarnesses: HarnessInfo[] = [
  {
    id: 'codex-main',
    kind: 'codex',
    driverId: 'codex',
    instanceId: 'codex-main',
    displayName: 'Codex CLI',
    description: 'Codex',
    protocolLabel: 'jsonrpc',
    binaryPath: '/usr/bin/codex',
    version: '1.0.0',
    health: 'ready',
    presentation: {
      shortLabel: 'Codex',
      accentColor: '#3b82f6',
      softBg: 'rgba(59,130,246,0.12)',
      tagline: 'OpenAI Codex',
    },
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['medium', 'high'],
      permissionModes: ['manual', 'accept_edits', 'auto'],
      sessionResume: true,
      sessionFork: true,
      imageInput: true,
      subagents: true,
    },
    models: [],
  },
  {
    id: 'custom-vendor-x',
    kind: 'vendor-x',
    driverId: 'vendor-x',
    instanceId: 'custom-vendor-x',
    displayName: 'VendorX Agent',
    description: 'External V5 isolated adapter',
    protocolLabel: 'v5-isolated',
    binaryPath: null,
    version: '2.0.0',
    health: 'ready',
    presentation: {
      shortLabel: 'VendorX',
      accentColor: '#10b981',
      softBg: 'rgba(16,185,129,0.12)',
      tagline: 'Zero-Hardcode Plugin Harness',
    },
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: [],
      permissionModes: ['manual', 'accept_edits'],
      sessionResume: true,
      sessionFork: false,
      imageInput: false,
      subagents: false,
    },
    models: [],
  },
];

const parentSession: Session = {
  id: 'sess_parent_1',
  workspaceId: 'ws_1',
  harnessId: 'codex-main',
  harnessKind: 'codex',
  nativeSessionId: 'nat_parent',
  participatingHarnesses: ['codex-main'],
  contextSyncMode: 'auto',
  cwd: '/repo/project',
  title: 'Parallel Feature Implementation',
  status: 'running',
  model: 'gpt-5',
  reasoningEffort: 'high',
  permissionMode: 'manual',
  lastSeq: 12,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: Date.now() - 10_000,
  updatedAt: Date.now(),
};

const sampleSubagents: SubagentRunRecord[] = [
  {
    subagentId: 'sub_backend',
    cohortId: 'cohort_alpha',
    parentSessionId: parentSession.id,
    childSessionId: 'sess_child_1',
    targetInstanceId: 'codex-main',
    targetDriverId: 'codex',
    roleTitle: 'Backend API Implementation',
    prompt: 'Implement /api/v1/items',
    isolation: 'worktree_write',
    worktreePath: '/repo/.harnessmate-worktrees/sub_backend',
    branchName: 'hm/sub/sub_backend',
    baseBranch: 'main',
    effectiveApprovalPolicy: 'manual',
    requestedApprovalPolicy: 'auto',
    depth: 1,
    timeoutMs: 900_000,
    failFast: false,
    status: 'completed',
    pendingApprovalCount: 0,
    diffStat: {
      filesChanged: 2,
      insertions: 48,
      deletions: 3,
      changedFiles: ['src/api.ts', 'src/routes.ts'],
    },
    summary: 'Implemented /api/v1/items with Zod validation',
    createdAt: Date.now() - 8000,
    finishedAt: Date.now() - 2000,
  },
  {
    subagentId: 'sub_tests',
    cohortId: 'cohort_alpha',
    parentSessionId: parentSession.id,
    childSessionId: 'sess_child_2',
    targetInstanceId: 'custom-vendor-x',
    targetDriverId: 'vendor-x',
    roleTitle: 'Integration Tests',
    prompt: 'Write integration tests',
    isolation: 'worktree_write',
    worktreePath: '/repo/.harnessmate-worktrees/sub_tests',
    branchName: 'hm/sub/sub_tests',
    baseBranch: 'main',
    effectiveApprovalPolicy: 'manual',
    depth: 1,
    timeoutMs: 900_000,
    failFast: false,
    status: 'awaiting_approval',
    pendingApprovalCount: 1,
    diffStat: null,
    summary: null,
    createdAt: Date.now() - 7000,
    finishedAt: null,
  },
  {
    subagentId: 'sub_audit',
    cohortId: 'cohort_alpha',
    parentSessionId: parentSession.id,
    childSessionId: 'sess_child_3',
    targetInstanceId: 'custom-vendor-x',
    targetDriverId: 'vendor-x',
    roleTitle: 'Security Audit',
    prompt: 'Review auth flow',
    isolation: 'read_only',
    worktreePath: null,
    branchName: null,
    baseBranch: null,
    effectiveApprovalPolicy: 'manual',
    depth: 1,
    timeoutMs: 900_000,
    failFast: false,
    status: 'running',
    pendingApprovalCount: 0,
    createdAt: Date.now() - 6000,
    finishedAt: null,
  },
];

const samplePendingApproval: ApprovalRequest = {
  id: 'appr_child_1',
  sessionId: 'sess_child_2',
  parentSessionId: parentSession.id,
  instanceId: 'custom-vendor-x',
  nativeRequestId: 'nat_appr_1',
  kind: 'command_approval',
  toolName: 'bash',
  toolKind: 'shell',
  summary: 'Run pnpm test',
  input: { command: 'pnpm test' },
  riskLevel: 'medium',
  status: 'pending',
  resolvedBy: null,
  decision: null,
  comment: null,
  createdAt: Date.now() - 1000,
  resolvedAt: null,
};

describe('Phase 3.2 · Multi-Harness Parallel Orchestrator UI', () => {
  it('renders ParallelExecutionBoard with multi-engine badges, concurrency quota, approval jump, stop & merge-back actions', () => {
    const board: OrchestratorBoardResponse = {
      parentSessionId: parentSession.id,
      enabled: true,
      activeCount: 2,
      maxConcurrent: 4,
      maxDepth: 1,
      currentDepth: 0,
      subagents: sampleSubagents,
      cohorts: [],
    };

    const html = renderToStaticMarkup(
      <ParallelExecutionBoardView
        parentSession={parentSession}
        board={board}
        harnesses={sampleHarnesses}
        pendingApprovals={[samplePendingApproval]}
        onRefresh={() => {}}
        onDelegate={() => {}}
        onOpenChildSession={() => {}}
        onOpenApproval={() => {}}
        onStopSubagent={() => {}}
        onReviewMerge={() => {}}
      />,
    );

    // Concurrency quota & ceiling info
    expect(html).toContain('2 / 4 运行中');
    expect(html).toContain('深度 0/1');
    expect(html).toContain('受控审批');

    // Zero-hardcoding multi-engine badges from HarnessPresentationMeta
    expect(html).toContain('Codex');
    expect(html).toContain('VendorX');
    expect(html).toContain('#10b981');

    // Subagent cards, branch chips, diffstat, approval CTA, stop & merge-back buttons
    expect(html).toContain('Backend API Implementation');
    expect(html).toContain('hm/sub/sub_backend');
    expect(html).toContain('+48 -3 · 2 文件');
    expect(html).toContain('预检冲突并合回');

    expect(html).toContain('Integration Tests');
    expect(html).toContain('等待审批');
    expect(html).toContain('前往审批 (1)');
    expect(html).toContain('data-testid="subagent-stop-btn-sub_tests"');
    expect(html).toContain('data-testid="subagent-stop-btn-sub_audit"');
  });

  it('registers orchestrator-board and ext:orchestrator.cohort in SlotRegistry and renders cohort summary card', () => {
    const registry = new SlotRegistry();
    registry.register({
      slot: 'inspector.tabs',
      id: 'orchestrator-board',
      pluginId: 'hm.plugin.multi-harness-orchestrator',
      pluginName: 'Multi-Harness Orchestrator',
      title: '并行编排看板',
      key: 'orchestrator-board',
      render: ({ session }) => (
        <ParallelExecutionBoardView
          parentSession={session}
          board={null}
          harnesses={sampleHarnesses}
          pendingApprovals={[]}
          onRefresh={() => {}}
          onOpenChildSession={() => {}}
          onOpenApproval={() => {}}
          onStopSubagent={() => {}}
          onReviewMerge={() => {}}
        />
      ),
    });

    registry.register({
      slot: 'chat.block',
      id: 'orchestrator-cohort-card',
      pluginId: 'hm.plugin.multi-harness-orchestrator',
      pluginName: 'Multi-Harness Orchestrator',
      title: '并行协作批次摘要卡',
      key: 'ext:orchestrator.cohort',
      render: ({ block }) =>
        block.type === 'ext:orchestrator.cohort' && 'payload' in block ? (
          <OrchestratorCohortBlockCard
            block={block}
            harnesses={sampleHarnesses}
            onReviewMerge={() => {}}
            onOpenChildSession={() => {}}
          />
        ) : null,
    });

    const boardSlots = registry.getItems('inspector.tabs', {
      hasSession: true,
      matchKey: 'orchestrator-board',
    });
    expect(boardSlots).toHaveLength(1);

    const cohortBlock: ExtensionTurnBlock = {
      blockId: 'orchestrator:cohort:cohort_alpha',
      turnId: 'turn_1',
      seq: 12,
      harnessInstanceId: 'codex-main',
      driverId: 'codex',
      status: 'completed',
      createdAt: Date.now(),
      type: 'ext:orchestrator.cohort',
      title: '并行协作批次 · 2/2 完成',
      fallbackSummary: 'cohort summary',
      payload: {
        cohortId: 'cohort_alpha',
        parentSessionId: parentSession.id,
        total: 2,
        completedCount: 2,
        failedCount: 0,
        subagents: [
          sampleSubagents[0],
          {
            ...sampleSubagents[1],
            status: 'completed',
            diffStat: { filesChanged: 1, insertions: 22, deletions: 0, changedFiles: ['tests/api.test.ts'] },
            summary: 'Added API test suite',
          },
        ],
      },
    };

    const cohortSlots = registry.getItems('chat.block', {
      hasSession: true,
      matchKey: 'ext:orchestrator.cohort',
    });
    expect(cohortSlots).toHaveLength(1);

    const html = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        {cohortSlots[0]!.render({ session: parentSession, block: cohortBlock })}
      </SlotRegistryProvider>,
    );

    expect(html).toContain('data-testid="orchestrator-cohort-card"');
    expect(html).toContain('cohort_alpha');
    expect(html).toContain('2 / 2 完成');
    expect(html).toContain('Codex');
    expect(html).toContain('VendorX');
    expect(html).toContain('hm/sub/sub_backend');
    expect(html).toContain('+48 -3 · 2 文件');
    expect(html).toContain('data-testid="cohort-merge-btn-sub_backend"');
    expect(html).toContain('预检冲突并合回');
  });

  it('renders MergeBackReviewModal allowing clean merges with cleanup option and blocking conflicting merges', () => {
    const diffStat: SubagentDiffStat = {
      filesChanged: 2,
      insertions: 48,
      deletions: 3,
      changedFiles: ['src/api.ts', 'src/routes.ts'],
    };

    // 1. Clean dry-run -> enabled confirm button & cleanup Worktree checkbox
    const cleanDryRun: GitDryRunMergeResult = {
      supported: true,
      gitVersion: '2.47.0',
      baseBranch: 'main',
      headBranch: 'hm/sub/sub_backend',
      hasConflicts: false,
      conflictFiles: [],
      treeSha: 'a'.repeat(40),
      message: 'hm/sub/sub_backend 可无冲突合并至 main',
    };

    const cleanHtml = renderToStaticMarkup(
      <MergeBackReviewModalView
        subagent={sampleSubagents[0]!}
        dryRun={cleanDryRun}
        diffStat={diffStat}
        harnesses={sampleHarnesses}
        loading={false}
        error={null}
        onConfirmMerge={() => {}}
        onClose={() => {}}
      />,
    );

    expect(cleanHtml).toContain('data-testid="merge-clean-banner"');
    expect(cleanHtml).toContain('预检通过');
    expect(cleanHtml).toContain('合并后清理 Worktree');
    expect(cleanHtml).toContain('src/api.ts');
    expect(cleanHtml).toContain('确认合回主分支');
    // Confirm button must NOT have the HTML disabled attribute in clean state
    const cleanConfirmBtnMatch = cleanHtml.match(/<button[^>]*data-testid="merge-confirm-btn"[^>]*>/);
    expect(cleanConfirmBtnMatch).not.toBeNull();
    expect(cleanConfirmBtnMatch![0]).not.toMatch(/\sdisabled(?:=""|[\s>])/);

    // 2. Conflicting dry-run -> conflict file list & disabled confirm button
    const conflictDryRun: GitDryRunMergeResult = {
      supported: true,
      gitVersion: '2.47.0',
      baseBranch: 'main',
      headBranch: 'hm/sub/sub_backend',
      hasConflicts: true,
      conflictFiles: ['src/shared.ts', 'src/config.ts'],
      treeSha: 'b'.repeat(40),
      message: '检测到 2 个合并冲突文件',
    };

    const conflictHtml = renderToStaticMarkup(
      <MergeBackReviewModalView
        subagent={sampleSubagents[0]!}
        dryRun={conflictDryRun}
        diffStat={diffStat}
        harnesses={sampleHarnesses}
        loading={false}
        error={null}
        onConfirmMerge={() => {}}
        onClose={() => {}}
      />,
    );

    expect(conflictHtml).toContain('data-testid="merge-conflict-banner"');
    expect(conflictHtml).toContain('检测到 2 个合并冲突');
    expect(conflictHtml).toContain('主工作区未受任何修改');
    expect(conflictHtml).toContain('src/shared.ts');
    expect(conflictHtml).toContain('src/config.ts');
    expect(conflictHtml).toContain('存在冲突 · 禁止盲目合回');
    // Confirm button MUST have the HTML disabled attribute when conflicts exist
    const conflictConfirmBtnMatch = conflictHtml.match(/<button[^>]*data-testid="merge-confirm-btn"[^>]*>/);
    expect(conflictConfirmBtnMatch).not.toBeNull();
    expect(conflictConfirmBtnMatch![0]).toMatch(/\sdisabled(?:=""|[\s>])/);
  });
});
