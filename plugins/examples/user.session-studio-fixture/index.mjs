export function apply(ctx) {
  ctx.provide('session.studio.v1', { available: () => true });
  ctx.provide('git.workspace.v1', {
    status: ({ workspaceId, sessionId }) => ({
      isGitRepo: true,
      changes: [{ path: 'fixture/w2-git-status.txt', status: 'M' }],
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
