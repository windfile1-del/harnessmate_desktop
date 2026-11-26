export function apply(ctx, config = {}) {
  const deniedTools = new Set(Array.isArray(config.deniedTools) ? config.deniedTools.map(String) : []);
  ctx.provide(
    'approval.policy.v1',
    {
      evaluateToolCall(req) {
        if (deniedTools.has(req.toolName)) {
          return { decision: 'deny', reason: `审批策略禁止执行工具 ${req.toolName}` };
        }
        return { decision: 'allow' };
      },
    },
    { version: '1.0.0', metadata: { title: '默认工具审批策略' } },
  );
}
