export const DEEPSEEK_DRIVER_ID = 'deepseek';

export const DEEPSEEK_DEFAULT_CONTEXT_WINDOW = 64_000;

export const DEEPSEEK_PRESENTATION = {
  shortLabel: 'DeepSeek',
  accentColor: '#4D6BFE',
  softBg: 'rgba(77, 107, 254, 0.14)',
  tagline: 'DeepSeek Reasoner & Chat (CLI / HTTP-SSE)',
  iconSvg:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3C7 3 3 7 3 12c0 4.5 3.3 8.3 7.7 8.9 2 .3 4.3-.4 5.9-1.9 2.3-2.2 3.2-5.9 2.1-9.1-.8-2.3-2.9-4.5-5.3-5.2-.4-.1-.9-.2-1.4-.2z"/><path d="M9.5 11.5c1-1.5 3.5-2 5-.8 1.2 1 1 3-.5 4-1.3.9-3.2.5-4.1-.7"/></svg>',
};

export const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner (R1)',
    description: '深度思维链推理模型 · 64K 上下文窗口',
    group: 'DeepSeek',
    isDefault: true,
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text'],
  },
  {
    id: 'deepseek-chat',
    displayName: 'DeepSeek Chat (V3)',
    description: '通用高效编码与对话模型 · 64K 上下文窗口',
    group: 'DeepSeek',
    isDefault: false,
    defaultEffort: 'medium',
    supportedEfforts: ['none', 'low', 'medium', 'high'],
    inputModalities: ['text'],
  },
];

export const DEEPSEEK_OPTION_DESCRIPTORS = [
  {
    kind: 'select',
    key: 'reasoningBudget',
    label: '推理预算',
    description: '控制思维链思考 Token 预算档位',
    defaultValue: 'medium',
    options: [
      { value: 'low', label: 'Low (4K)', description: '轻量快速推理' },
      { value: 'medium', label: 'Medium (16K)', description: '均衡推理预算' },
      { value: 'high', label: 'High (32K)', description: '深度复杂问题推理' },
    ],
  },
  {
    kind: 'boolean',
    key: 'deepThink',
    label: 'Deep Think',
    description: '启用 DeepSeek Reasoner 深度思考输出',
    defaultValue: true,
  },
];

export const DEEPSEEK_CAPABILITIES = {
  streaming: true,
  interactiveApproval: true,
  reasoningEfforts: ['none', 'low', 'medium', 'high'],
  permissionModes: ['manual', 'accept_edits', 'auto'],
  sessionResume: true,
  sessionFork: false,
  imageInput: false,
  subagents: false,
};

export const DEEPSEEK_CAPABILITIES_V2 = {
  ...DEEPSEEK_CAPABILITIES,
  transport: 'http_sse',
  historyInjectionMode: 'inline',
  supportsNativeRollback: false,
  supportsNativeFork: false,
  supportsActiveSteering: false,
  supportsUsageLimits: false,
  supportsDynamicOptions: true,
  nativeCommands: [],
  optionDescriptors: DEEPSEEK_OPTION_DESCRIPTORS,
};

export function normalizeDeepSeekConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const mode = cfg.mode === 'cli' || cfg.mode === 'api_compatible' ? cfg.mode : 'api_compatible';
  const cliCommand = typeof cfg.cliCommand === 'string' && cfg.cliCommand.trim()
    ? cfg.cliCommand.trim()
    : 'deepseek-code';
  const apiBaseUrl = typeof cfg.apiBaseUrl === 'string' && cfg.apiBaseUrl.trim()
    ? cfg.apiBaseUrl.trim().replace(/\/+$/, '')
    : 'https://api.deepseek.com';
  const secretRef =
    cfg.apiKeyRef && typeof cfg.apiKeyRef === 'object' && typeof cfg.apiKeyRef.secretRef === 'string' && cfg.apiKeyRef.secretRef.trim()
      ? cfg.apiKeyRef.secretRef.trim()
      : (typeof cfg.secretRef === 'string' && cfg.secretRef.trim() ? cfg.secretRef.trim() : 'deepseek:api_key');
  const defaultModel = typeof cfg.defaultModel === 'string' && cfg.defaultModel.trim()
    ? cfg.defaultModel.trim()
    : 'deepseek-reasoner';
  const contextWindowTokens =
    typeof cfg.contextWindowTokens === 'number' && Number.isFinite(cfg.contextWindowTokens) && cfg.contextWindowTokens > 0
      ? Math.floor(cfg.contextWindowTokens)
      : DEEPSEEK_DEFAULT_CONTEXT_WINDOW;

  return {
    mode,
    cliCommand,
    apiBaseUrl,
    apiKeyRef: { secretRef },
    defaultModel,
    contextWindowTokens,
  };
}

export function budgetLimitTokens(budget) {
  if (budget === 'low') return 4_096;
  if (budget === 'high') return 32_768;
  return 16_384;
}

export function buildReasoningBudgetBlock({
  turnId,
  itemId,
  model,
  reasoningBudget,
  deepThink,
  reasoningTokens,
  outputTokens,
  status = 'completed',
}) {
  const budget = reasoningBudget === 'low' || reasoningBudget === 'high' ? reasoningBudget : 'medium';
  const limitTokens = budgetLimitTokens(budget);
  const usedReasoning = Math.max(0, Number(reasoningTokens) || 0);
  const usedOutput = Math.max(0, Number(outputTokens) || 0);
  const ratioPercent = Math.min(100, Math.round((usedReasoning / Math.max(1, limitTokens)) * 100));
  return {
    type: 'turn_block.ext',
    turnId,
    itemId: itemId || `deepseek:budget:${turnId}`,
    blockType: 'ext:deepseek.reasoning_budget',
    title: 'DeepSeek 推理预算消耗',
    fallbackSummary: `Model=${model} | Budget=${budget} (${usedReasoning}/${limitTokens} reasoning tokens, ${ratioPercent}%) | DeepThink=${deepThink ? 'on' : 'off'}`,
    status,
    payload: {
      model,
      reasoningBudget: budget,
      deepThink: Boolean(deepThink),
      reasoningTokens: usedReasoning,
      outputTokens: usedOutput,
      budgetLimitTokens: limitTokens,
      ratioPercent,
    },
  };
}

export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
  return out;
}

export function parseResetAtMs(headers = {}, nowMs = Date.now()) {
  const lower = Object.fromEntries(
    Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]),
  );
  const retryAfter = lower['retry-after'];
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return nowMs + Math.ceil(secs * 1_000);
    }
    const parsedDate = Date.parse(retryAfter);
    if (Number.isFinite(parsedDate) && parsedDate > nowMs) {
      return parsedDate;
    }
  }
  const rateReset = lower['x-ratelimit-reset'] || lower['x-ratelimit-reset-requests'];
  if (rateReset) {
    const num = Number(rateReset);
    if (Number.isFinite(num) && num > 0) {
      return num > 10_000_000_000 ? num : num * 1_000;
    }
  }
  return null;
}

export function classifyDeepSeekHttpError(status, headers, bodyText, secrets = []) {
  const resetAt = parseResetAtMs(headers);
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch {
    detail = String(bodyText || '').slice(0, 200);
  }
  const safeDetail = scrubSecrets(detail, secrets).trim();
  if (status === 429) {
    return {
      code: 'usage_limit',
      failureClass: 'usage_limit',
      resetAt: resetAt ?? Date.now() + 60_000,
      message: safeDetail ? `DeepSeek API rate limit exceeded: ${safeDetail}` : 'DeepSeek API usage limit exceeded (HTTP 429).',
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: 'auth_failed',
      failureClass: 'auth_failed',
      resetAt: null,
      message: 'DeepSeek API authentication failed. Please check the configured API key reference.',
    };
  }
  if (status >= 500) {
    return {
      code: 'provider_unavailable',
      failureClass: 'provider_unavailable',
      resetAt: null,
      message: safeDetail || `DeepSeek API service unavailable (HTTP ${status}).`,
    };
  }
  return {
    code: 'provider_error',
    failureClass: 'provider_error',
    resetAt: null,
    message: safeDetail || `DeepSeek API request failed (HTTP ${status}).`,
  };
}

export function createSseParser(onFrame) {
  let buffer = '';
  let dataLines = [];

  const flushEvent = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n').trim();
    dataLines = [];
    if (!raw) return;
    if (raw === '[DONE]') {
      onFrame({ done: true });
      return;
    }
    try {
      const data = JSON.parse(raw);
      onFrame({ done: false, data });
    } catch {
      // Ignore malformed SSE payload line safely
    }
  };

  return {
    push(chunk) {
      buffer += String(chunk ?? '');
      while (true) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const rawLine = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (rawLine === '') {
          flushEvent();
          continue;
        }
        if (rawLine.startsWith(':')) continue;
        if (rawLine.startsWith('data:')) {
          dataLines.push(rawLine.slice(5).replace(/^ /, ''));
        }
      }
    },
    end() {
      if (buffer.trim()) {
        const rem = buffer.replace(/\r$/, '');
        buffer = '';
        if (rem.startsWith('data:')) {
          dataLines.push(rem.slice(5).replace(/^ /, ''));
        }
      }
      flushEvent();
    },
  };
}

export function composeInlinePrompt(text, contextSync) {
  if (!contextSync?.deltaMarkdown) return text;
  return `${contextSync.deltaMarkdown}\n\n---\n\n${text}`;
}
