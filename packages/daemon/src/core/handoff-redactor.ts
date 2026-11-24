export type HandoffRedactionSource = 'handoff_compile' | 'handoff_snapshot' | 'mcp_session_read';

export interface HandoffRedactContext {
  sessionId: string;
  source: HandoffRedactionSource;
  targetHarnessId?: string;
}

export interface HandoffRedactHookResult {
  text: string;
  redactedCount?: number;
  categories?: string[];
}

export type HandoffRedactHook = (
  text: string,
  context: HandoffRedactContext,
) => Promise<string | HandoffRedactHookResult> | string | HandoffRedactHookResult;

export interface RedactionResult {
  text: string;
  redactedCount: number;
  categories: string[];
}

export class HandoffRedactionError extends Error {
  readonly code = 'E_HANDOFF_REDACTION_FAILED' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HandoffRedactionError';
  }
}

interface BuiltinRedactionRule {
  category: string;
  pattern: RegExp;
  replace: (match: string, ...args: unknown[]) => string;
}

const BUILTIN_RULES: readonly BuiltinRedactionRule[] = [
  {
    category: 'pem_private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => '[REDACTED:pem_private_key]',
  },
  {
    category: 'anthropic_key',
    pattern: /\bsk-ant-(?:api\d+-)?[A-Za-z0-9_-]{20,}\b/g,
    replace: () => '[REDACTED:anthropic_key]',
  },
  {
    category: 'openai_key',
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
    replace: () => '[REDACTED:openai_key]',
  },
  {
    category: 'aws_access_key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => '[REDACTED:aws_access_key]',
  },
  {
    category: 'aws_secret_key',
    pattern: /(\bAWS_SECRET_ACCESS_KEY(?:['"])?\s*[:=]\s*['"]?)(?!\[REDACTED)([A-Za-z0-9/+=]{40})(['"]?)/gi,
    replace: (_m, prefix, _secret, suffix) => `${String(prefix)}[REDACTED:aws_secret_key]${String(suffix)}`,
  },
  {
    category: 'github_token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    replace: () => '[REDACTED:github_token]',
  },
  {
    category: 'slack_token',
    pattern: /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,}\b/g,
    replace: () => '[REDACTED:slack_token]',
  },
  {
    category: 'bearer_token',
    pattern: /(\bAuthorization\s*:\s*Bearer\s+|\bBearer\s+)(?!\[REDACTED)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace: (_m, prefix) => `${String(prefix)}[REDACTED:bearer_token]`,
  },
  {
    category: 'jwt_token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => '[REDACTED:jwt_token]',
  },
  {
    category: 'password_url',
    pattern: /([a-z][a-z0-9+.-]*:\/\/[^:\s/@'"]+:)(?!\[REDACTED)((?:(?!:\/\/)[^\s'"`])+)(@[^@\s/'"]+(?:(?!:\/\/)[^\s'"`])*)/gi,
    replace: (_m, prefix, _pass, suffix) => `${String(prefix)}[REDACTED:password_url]${String(suffix)}`,
  },
  {
    category: 'env_secret_assign',
    pattern:
      /(\b(?:[A-Z0-9_]*?(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|CLIENT_SECRET|PASSWORD|PASSWD|TOKEN|SECRET))\b(?:['"])?\s*[:=]\s*)(?:("(?!\[REDACTED)[^"\r\n]{8,}")|('(?!\[REDACTED)[^'\r\n]{8,}')|(`(?!\[REDACTED)[^`\r\n]{8,}`)|((?!\[REDACTED)[^\s'"`]{8,}))/gi,
    replace: (_m, keyAssign, dq, sq, bq) => {
      const quote = dq ? '"' : sq ? "'" : bq ? '`' : '';
      return `${String(keyAssign)}${quote}[REDACTED:env_secret_assign]${quote}`;
    },
  },
];

export function redactHandoffTextSync(text: string): RedactionResult {
  if (!text) {
    return { text, redactedCount: 0, categories: [] };
  }

  let current = text;
  let redactedCount = 0;
  const categories = new Set<string>();

  for (const rule of BUILTIN_RULES) {
    rule.pattern.lastIndex = 0;
    let matchedInRule = 0;
    current = current.replace(rule.pattern, (...args) => {
      matchedInRule += 1;
      return rule.replace(args[0] as string, ...args.slice(1));
    });
    if (matchedInRule > 0) {
      redactedCount += matchedInRule;
      categories.add(rule.category);
    }
  }

  return {
    text: current,
    redactedCount,
    categories: [...categories],
  };
}

export class HandoffRedactor {
  private readonly hookTimeoutMs: number;
  private readonly hooks: HandoffRedactHook[] = [];

  constructor(options?: { hookTimeoutMs?: number; hooks?: HandoffRedactHook[] }) {
    this.hookTimeoutMs = Math.max(1, options?.hookTimeoutMs ?? 2_000);
    if (options?.hooks) {
      this.hooks.push(...options.hooks);
    }
  }

  registerHook(hook: HandoffRedactHook): () => void {
    this.hooks.push(hook);
    return () => {
      const idx = this.hooks.indexOf(hook);
      if (idx >= 0) {
        this.hooks.splice(idx, 1);
      }
    };
  }

  async redact(
    text: string,
    context: HandoffRedactContext,
    extraHooks?: HandoffRedactHook[],
  ): Promise<RedactionResult> {
    if (!text) {
      return { text, redactedCount: 0, categories: [] };
    }

    const initial = redactHandoffTextSync(text);
    let current = initial.text;
    let totalCount = initial.redactedCount;
    const categories = new Set<string>(initial.categories);

    const allHooks = extraHooks?.length ? [...this.hooks, ...extraHooks] : this.hooks;
    for (const hook of allHooks) {
      const prev = current;
      const hookOutput = await this.invokeHookWithTimeout(hook, prev, context);
      if (typeof hookOutput === 'string') {
        current = hookOutput;
        if (current !== prev) {
          totalCount += 1;
          categories.add('custom_hook');
        }
      } else if (
        hookOutput &&
        typeof hookOutput === 'object' &&
        typeof (hookOutput as HandoffRedactHookResult).text === 'string'
      ) {
        const resultObj = hookOutput as HandoffRedactHookResult;
        if (
          resultObj.redactedCount !== undefined &&
          (typeof resultObj.redactedCount !== 'number' ||
            !Number.isFinite(resultObj.redactedCount) ||
            resultObj.redactedCount < 0)
        ) {
          throw new HandoffRedactionError('Handoff redaction hook returned invalid redactedCount');
        }
        if (
          resultObj.categories !== undefined &&
          (!Array.isArray(resultObj.categories) || resultObj.categories.some((c) => typeof c !== 'string'))
        ) {
          throw new HandoffRedactionError('Handoff redaction hook returned invalid categories');
        }
        current = resultObj.text;
        const deltaCount = resultObj.redactedCount ?? (current !== prev ? 1 : 0);
        totalCount += deltaCount;
        if (resultObj.categories && resultObj.categories.length > 0) {
          for (const cat of resultObj.categories) {
            if (cat) categories.add(cat);
          }
        } else if (current !== prev) {
          categories.add('custom_hook');
        }
      } else {
        throw new HandoffRedactionError('Handoff redaction hook returned an invalid output type');
      }
    }

    // Defense-in-depth: re-run built-in secret rules after custom hooks
    if (allHooks.length > 0) {
      const after = redactHandoffTextSync(current);
      current = after.text;
      totalCount += after.redactedCount;
      for (const cat of after.categories) {
        categories.add(cat);
      }
    }

    return {
      text: current,
      redactedCount: totalCount,
      categories: [...categories],
    };
  }

  private async invokeHookWithTimeout(
    hook: HandoffRedactHook,
    text: string,
    context: HandoffRedactContext,
  ): Promise<string | HandoffRedactHookResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const hookPromise = Promise.resolve().then(() => hook(text, context));
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new HandoffRedactionError(`Handoff redaction hook timed out after ${this.hookTimeoutMs}ms`));
        }, this.hookTimeoutMs);
        timer.unref?.();
      });
      return await Promise.race([hookPromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof HandoffRedactionError) {
        throw error;
      }
      throw new HandoffRedactionError(
        `Handoff redaction hook failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
