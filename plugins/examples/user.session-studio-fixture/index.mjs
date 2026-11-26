export function apply(ctx) {
  ctx.provide('session.studio.v1', { available: () => true });
  ctx.provide('git.workspace.v1', {
    getStatus: ({ workspaceId, sessionId, cwd }) => ({
      available: true,
      instanceId: ctx.instanceId,
      status: {
        isGitRepo: true, repoRoot: cwd, gitCommonDir: null, branch: 'fixture', ahead: 0, behind: 0,
        changes: [{ path: 'fixture/w2-git-status.txt', indexStatus: ' ', worktreeStatus: 'M', untracked: false }],
        stagedCount: 0, unstagedCount: 1, untrackedCount: 0, totalChanged: 1,
      },
      workspaceId,
      sessionId,
    }),
  });
  ctx.provide('session.failover.v1', {
    recommend: ({ sessionId }) => ({
      sessionId,
      candidate: 'fixture-secondary',
      reason: 'W3 建议契约夹具',
      action: 'suggest',
    }),
  });
}
