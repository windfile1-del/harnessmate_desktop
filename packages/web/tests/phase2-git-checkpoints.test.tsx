import type {
  CheckpointRevertResult,
  GitDryRunMergeResult,
  GitStatusSummary,
  GitWorktreeEntry,
  Session,
  SessionCheckpointRecord,
  Workspace,
  WorkspaceSetupScriptInfo,
} from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CheckpointTurnBadge,
  RevertCheckpointDialog,
  UndoRevertBanner,
} from '../src/components/CheckpointControls';
import {
  DiffCodeViewer,
  DiffInspectorPanel,
  parseUnifiedToSplitLines,
} from '../src/components/DiffInspectorPanel';
import { WorktreeManagerModal } from '../src/components/WorktreeManagerModal';
import { mergeTurnBlockRecords, projectSessionEvents, turnBlockRecordToBlock } from '../src/lib/projector';
import { Slot, SlotRegistry, SlotRegistryProvider, SlotSessionProvider } from '../src/slots';

const sampleSession: Session = {
  id: 'sess_git_ui',
  workspaceId: 'ws_1',
  harnessId: 'claude',
  harnessKind: 'claude',
  title: 'Git Checkpoints UI Test',
  cwd: 'd:/repo',
  worktreeBranch: null,
  nativeSessionId: null,
  model: null,
  reasoningEffort: null,
  permissionMode: 'manual',
  status: 'idle',
  lastSeq: 5,
  pendingApprovalCount: 0,
  createdAt: 1000,
  updatedAt: 2000,
};

describe('Phase 2.2 · DiffInspectorPanel & Unified/Split Diff (V5 inspector.diff slot)', () => {
  it('parses unified diff into aligned split rows and renders both Unified and Split modes', () => {
    const unified = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ a/src/app.ts',
      '@@ -1,2 +1,3 @@',
      ' export const a = 1;',
      '-export const b = 2;',
      '+export const b = 20;',
      '+export const c = 3;',
    ].join('\n');

    const rows = parseUnifiedToSplitLines(unified);
    expect(rows.some((r) => r.leftKind === 'del' && r.leftText.includes('b = 2'))).toBe(true);
    expect(rows.some((r) => r.rightKind === 'add' && r.rightText.includes('b = 20'))).toBe(true);
    expect(rows.some((r) => r.leftKind === 'empty' && r.rightText.includes('c = 3'))).toBe(true);

    const unifiedHtml = renderToStaticMarkup(<DiffCodeViewer diff={unified} viewMode="unified" />);
    expect(unifiedHtml).toContain('data-testid="diff-view-unified"');
    expect(unifiedHtml).toContain('-export const b = 2;');
    expect(unifiedHtml).toContain('+export const b = 20;');

    const splitHtml = renderToStaticMarkup(<DiffCodeViewer diff={unified} viewMode="split" />);
    expect(splitHtml).toContain('data-testid="diff-view-split"');
    expect(splitHtml).toContain('<table');
    expect(splitHtml).toContain('export const b = 20;');
  });

  it('mounts DiffInspectorPanel into V5 inspector.diff slot with file tree, delivery actions, and non-Git git init empty state', () => {
    const git: GitStatusSummary = {
      isGitRepo: true,
      branch: 'feat/checkpoints',
      ahead: 2,
      behind: 0,
      changes: [{ path: 'src/app.ts', status: 'modified', staged: false, additions: 5, deletions: 2 }],
      diff: '',
    };
    const checkpoints: SessionCheckpointRecord[] = [
      {
        checkpointId: 'ckpt_1',
        sessionId: sampleSession.id,
        turnSeq: 3,
        phase: 'turn_post',
        gitRef: 'refs/harnessmate/checkpoints/sess_git_ui/ckpt_1',
        treeSha: '1111111111111111111111111111111111111111',
        baseHeadSha: null,
        filesChanged: 1,
        insertions: 5,
        deletions: 2,
        skippedLargeFiles: [],
        createdAt: 1000,
      },
    ];

    const registry = new SlotRegistry();
    registry.register({
      slot: 'inspector.diff',
      id: 'git-diff-inspector',
      pluginId: 'core.git-inspector',
      pluginName: 'Git Checkpoints & Diff',
      render: ({ session, git: g, onRefresh }) => (
        <DiffInspectorPanel
          session={session}
          git={g}
          onRefresh={onRefresh}
          checkpointsOverride={checkpoints}
        />
      ),
    });

    const html = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <Slot
            name="inspector.diff"
            slotProps={{ session: sampleSession, git, onRefresh: vi.fn() }}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );

    expect(html).toContain('feat/checkpoints');
    expect(html).toContain('Unified');
    expect(html).toContain('Split');
    expect(html).toContain('src/app.ts');
    expect(html).toContain('检查点对比 (1)');
    expect(html).toContain('提交');
    expect(html).toContain('推送');
    expect(html).toContain('创建 PR');

    // Non-Git empty state with optional 1-click git init button
    const nonGit: GitStatusSummary = {
      isGitRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      changes: [],
      diff: '',
    };
    const emptyHtml = renderToStaticMarkup(
      <DiffInspectorPanel
        session={sampleSession}
        git={nonGit}
        onRefresh={vi.fn()}
        checkpointsOverride={[]}
      />,
    );
    expect(emptyHtml).toContain('data-testid="diff-non-git-empty"');
    expect(emptyHtml).toContain('初始化 Git 仓库 (git init)');
  });
});

describe('Phase 2.2 · CheckpointTurnBadge (chat.block), RevertCheckpointDialog & UndoRevertBanner', () => {
  it('projects checkpoint_marker TurnBlockRecord and renders CheckpointTurnBadge via V5 chat.block slot', () => {
    const record = {
      itemId: 't1:checkpoint:ckpt_1',
      schemaVersion: 2 as const,
      sessionId: sampleSession.id,
      turnId: 't1',
      seq: 8,
      instanceId: 'claude',
      driverId: 'claude',
      blockType: 'checkpoint_marker',
      status: 'completed' as const,
      title: '检查点 · Turn #8',
      textBody: '+12 -3 · 2 个文件变更',
      payload: {
        checkpointId: 'ckpt_1',
        turnSeq: 8,
        phase: 'turn_post',
        gitRef: 'refs/harnessmate/checkpoints/sess_git_ui/ckpt_1',
        treeSha: 'abc123',
        filesChanged: 2,
        insertions: 12,
        deletions: 3,
        skippedLargeFiles: ['big.bin'],
      },
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const block = turnBlockRecordToBlock(record);
    expect(block.type).toBe('checkpoint_marker');
    if (block.type !== 'checkpoint_marker') return;

    // Verify mergeTurnBlockRecords preserves checkpoint_marker in projected timeline
    const base = projectSessionEvents([
      {
        sessionId: sampleSession.id,
        seq: 1,
        turnId: 't1',
        type: 'message.user',
        payload: { text: 'edit app' },
        createdAt: 900,
      },
    ]);
    const merged = mergeTurnBlockRecords(base, [record]);
    expect(merged.turns[0]?.blocks.some((b) => b.type === 'checkpoint_marker')).toBe(true);

    const registry = new SlotRegistry();
    registry.register({
      slot: 'chat.block',
      id: 'git-checkpoint-marker',
      pluginId: 'core.git-inspector',
      pluginName: 'Git Checkpoints & Diff',
      key: 'checkpoint_marker',
      render: ({ session, block: b }) =>
        b.type === 'checkpoint_marker' ? (
          <CheckpointTurnBadge
            session={session}
            block={b}
            harnessLabel="Claude"
            supportsNativeRollback={false}
            onViewDiff={vi.fn()}
            onRevert={vi.fn()}
          />
        ) : null,
    });

    const html = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <Slot
            name="chat.block"
            matchKey="checkpoint_marker"
            slotProps={{ session: sampleSession, block }}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );

    expect(html).toContain('检查点 · Turn #8');
    expect(html).toContain('+12');
    expect(html).toContain('-3');
    expect(html).toContain('跳过 1 个大文件');
    expect(html).toContain('查看 Diff');
    expect(html).toContain('回滚到此轮前');
  });

  it('honestly discloses supportsNativeRollback false vs true in RevertCheckpointDialog and renders UndoRevertBanner', () => {
    const nonNativeHtml = renderToStaticMarkup(
      <RevertCheckpointDialog
        open
        turnSeq={8}
        checkpointId="ckpt_claude"
        harnessLabel="Claude"
        supportsNativeRollback={false}
        filesChanged={2}
        insertions={12}
        deletions={3}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(nonNativeHtml).toContain('当前驱动 (Claude) 不支持原生对话回滚');
    expect(nonNativeHtml).toContain('不会静默伪造对话回滚');
    expect(nonNativeHtml).toContain('pre_revert');
    expect(nonNativeHtml).toMatch(/<input[^>]*disabled=""[^>]*value="native_and_files"/);
    expect(nonNativeHtml).toMatch(/<input[^>]*checked=""[^>]*value="files_only"/);

    const nativeHtml = renderToStaticMarkup(
      <RevertCheckpointDialog
        open
        turnSeq={4}
        checkpointId="ckpt_codex"
        harnessLabel="Codex"
        supportsNativeRollback
        filesChanged={1}
        insertions={5}
        deletions={1}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(nativeHtml).toContain('当前驱动 (Codex) 支持原生对话回滚');
    expect(nativeHtml).toContain('对话先回滚、文件后还原');
    expect(nativeHtml).toMatch(/<input[^>]*checked=""[^>]*value="native_and_files"/);

    const revertResult: CheckpointRevertResult = {
      revertedToCheckpointId: 'ckpt_codex',
      targetTurnSeq: 4,
      preRevertCheckpointId: 'ckpt_pre_revert_99',
      modeUsed: 'native_and_files',
      nativeRolledBack: true,
      newNativeBindingReset: false,
      filesRestored: 2,
      untrackedRemoved: 1,
      skippedLargeFiles: [],
    };
    const bannerHtml = renderToStaticMarkup(
      <UndoRevertBanner revertResult={revertResult} onUndo={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(bannerHtml).toContain('data-testid="undo-revert-banner"');
    expect(bannerHtml).toContain('撤销回滚 (Undo Revert)');
  });
});

describe('Phase 2.2 · WorktreeManagerModal (Worktrees, Dry-Run Merge & Setup Script Trust)', () => {
  it('renders managed worktrees, conflict pre-check list, and .harnessmate/setup full content + SHA-256 trust gate', () => {
    const workspaces: Workspace[] = [
      {
        id: 'ws_1',
        name: 'demo-repo',
        rootPath: 'd:/demo-repo',
        isGitRepo: true,
        gitBranch: 'main',
        createdAt: 1000,
      },
    ];
    const worktrees: GitWorktreeEntry[] = [
      {
        path: 'd:/demo-repo',
        branch: 'main',
        headSha: '111122223333',
        isMain: true,
        isBare: false,
        locked: false,
        prunable: false,
        dirtyCount: 0,
        linkedSessionIds: [],
      },
      {
        path: 'd:/demo-repo/.harnessmate-worktrees/feat-auth',
        branch: 'feat/auth',
        headSha: '444455556666',
        isMain: false,
        isBare: false,
        locked: false,
        prunable: false,
        dirtyCount: 2,
        linkedSessionIds: ['sess_1'],
      },
    ];
    const untrustedScript: WorkspaceSetupScriptInfo = {
      exists: true,
      relativePath: '.harnessmate/setup.ps1',
      content: 'pnpm install\necho "ready"',
      sha256: 'a'.repeat(64),
      trusted: false,
      trustedAt: null,
    };
    const dryRun: GitDryRunMergeResult = {
      supported: true,
      baseBranch: 'main',
      headBranch: 'feat/auth',
      hasConflicts: true,
      conflictFiles: ['src/auth.ts'],
      treeSha: null,
      message: '检测到 1 个潜在合并冲突文件',
      gitVersion: '2.45.0',
    };

    const html = renderToStaticMarkup(
      <WorktreeManagerModal
        onClose={vi.fn()}
        workspacesOverride={workspaces}
        initialWorktrees={worktrees}
        initialSetupScript={untrustedScript}
        initialDryRunResult={dryRun}
      />,
    );

    expect(html).toContain('feat/auth');
    expect(html).toContain('2 处未提交');
    expect(html).toContain('关联 1 个会话');
    expect(html).toContain('data-testid="dry-run-merge-result"');
    expect(html).toContain('src/auth.ts');
    expect(html).toContain('pnpm install');
    expect(html).toContain('a'.repeat(64));
    expect(html).toContain('未信任（禁止自动执行）');
    expect(html).toContain('disabled=""');
  });
});
