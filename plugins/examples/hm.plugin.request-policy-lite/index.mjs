/** @type {import('@harnessmate/plugin-api').ApprovalPolicyServiceV1} */
const documentationOnly = null;
export function apply(ctx, config = {}) {
  const evaluate = req => ({ decision: req.kind === 'secret_request' || req.kind === 'user_question'
    ? 'ask' : config.decision ?? 'ask', scope: config.scope ?? 'once', reason: `lite:${ctx.instanceId}` });
  ctx.provide('approval.policy.v1', { evaluateToolCall: evaluate, evaluateRequest: evaluate }, { version: '1.0.0' });
}
