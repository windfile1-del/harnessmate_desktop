export function apply(ctx) {
  const listAccounts = () => [{
    instanceId: 'fixture-account',
    harnessId: 'fixture-account',
    harnessKind: 'codex',
    driverId: 'codex',
    displayName: '示例账号',
    loggedIn: false,
    accountLabel: null,
    planType: null,
    authMethod: null,
    billingTier: 'unknown',
    rateLimits: [],
    dailyBuckets: [],
    localSessionCount: 0,
    localInputTokens: 0,
    localOutputTokens: 0,
    localCachedTokens: 0,
    localCostUsd: 0,
    fetchedAt: Date.now(),
    cached: false,
  }];
  ctx.provide('harness.usage.v1', {
    listAccounts,
    collectInstanceUsage: (instanceId) => ({
      ...listAccounts()[0],
      instanceId,
      harnessId: instanceId,
      error: '当前实例使用额度夹具',
    }),
  });
  ctx.routes.register('/accounts', () => ({
    status: 200,
    body: { accounts: listAccounts(), instanceId: ctx.instanceId },
  }));
  ctx.tools.register({
    name: 'who_am_i',
    description: 'Return the ID of the fixture instance servicing this request.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ctx.instanceId,
  });
}
