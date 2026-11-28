// Defaults are replaceable instance configuration, never kernel restrictions.
export function apply(ctx, config = {}) {
  const deniedTools = new Set(config.deniedTools ?? []);
  const evaluate = req => {
    if (req.kind === 'user_question' || req.kind === 'secret_request') return { decision: 'ask' };
    if (deniedTools.has(req.toolName)) return { decision: 'deny', reason: 'configured denied tool' };
    // Preserve old model-tool callers that have no permission-mode context.
    if (!req.mode) return { decision: 'allow', scope: 'once' };
    if ((config.reviewHighRisk ?? true) && ['high','critical'].includes(req.riskLevel)) return { decision: 'ask', reason: 'default risk review' };
    const edit = req.toolKind === 'file_edit' || req.kind === 'file_change_approval';
    if (req.mode === 'auto') return { decision: 'allow', scope: 'once' };
    if (req.mode === 'accept_edits' && (edit || req.readOnly)) return { decision: 'allow', scope: 'once' };
    if (req.mode === 'plan') return { decision: req.readOnly ? 'allow' : 'deny', scope: 'once', reason: 'plan policy' };
    return { decision: 'ask' };
  };
  ctx.provide('approval.policy.v1', { evaluateToolCall: evaluate, evaluateRequest: evaluate }, { version: '1.1.0' });
}
