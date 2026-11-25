import type { AgyLaunchContext } from './agy/agy-launch-context.js';
import { LIVE_ONLY_INTERACTIVE_WORKFLOW_COMMANDS } from './agy/native/commands/descriptors.js';
import { execCliQuick } from './process.js';
import type { AdapterSessionConfig } from './types.js';

export class AgyAuthRequiredError extends Error {
  readonly code = -32000;
  constructor(message = 'Antigravity requires authentication') {
    super(message);
    this.name = 'AgyAuthRequiredError';
  }
}

export class AgyInteractiveWorkflowFallbackError extends Error {
  readonly code = 'UNSUPPORTED_ACTION' as const;
  constructor(commandName: string) {
    super(
      `AGY 交互式原生工作流 /${commandName} 必须通过当前 live ACP 会话执行，禁止落入 final-only 辅助 CLI 进程`,
    );
    this.name = 'AgyInteractiveWorkflowFallbackError';
  }
}

export interface AgyCommandExecutionOptions {
  env?: Record<string, string | undefined>;
  unsetEnv?: readonly string[];
  appDataDir?: string;
  launchContext?: AgyLaunchContext;
  /** When native workflow live routing is enabled, also prevent /goal from using auxiliary CLI fallback. */
  blockGoalAuxiliaryFallback?: boolean;
}

const ALLOWED_INSPECT_COMMANDS = new Set<string>(['/usage', '/skills']);

export function extractSlashCommandName(rawCommand: string): string | null {
  const match = /^\s*\/([a-z0-9][a-z0-9_-]*)/i.exec(rawCommand);
  return match ? match[1]!.toLowerCase() : null;
}

export function isInteractiveWorkflowSlashCommand(
  rawCommand: string,
  opts?: { includeGoal?: boolean },
): boolean {
  const name = extractSlashCommandName(rawCommand);
  if (!name) return false;
  if (LIVE_ONLY_INTERACTIVE_WORKFLOW_COMMANDS.has(name)) return true;
  if (opts?.includeGoal && name === 'goal') return true;
  return false;
}

interface AgyCliResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  command?: { name?: string; data?: unknown };
}

const AUTH_PROMPT_PATTERN =
  /Authentication required|Please visit the URL to log in|Please sign in|You are not logged into Antigravity/i;

function resolveExecutionEnv(opts?: AgyCommandExecutionOptions): {
  env?: Record<string, string | undefined>;
  unsetEnv?: readonly string[];
} {
  if (opts?.launchContext) {
    return opts.launchContext.buildEnv({ extraEnv: opts.env });
  }
  return { env: opts?.env, unsetEnv: opts?.unsetEnv };
}

export async function inspectAgyCommand(
  binary: string,
  cwd: string,
  command: '/usage' | '/skills',
  opts?: AgyCommandExecutionOptions,
): Promise<unknown> {
  if (!ALLOWED_INSPECT_COMMANDS.has(command)) {
    throw new Error(`仅允许只读独立查询 /usage 或 /skills，已拒绝: ${String(command)}`);
  }
  const ctx = opts?.launchContext;
  if (
    ctx &&
    ctx.isolationMode === 'profile_isolated' &&
    ctx.authMethod === 'oauth-personal' &&
    !ctx.hasLocalTokenFile()
  ) {
    throw new AgyAuthRequiredError('AGY 隔离账号尚未登录，请先完成官方 Google 登录');
  }

  // Strictly read-only print JSON query: never passes `--conversation` and never mutates conversation history.
  const baseArgs = ['-p', command, '--output-format', 'json', '--print-timeout', '20s'];
  // Top-level `agy` rejects `--app-data-dir` / `--gemini-dir`; `AgyLaunchContext.buildCliArgs()`
  // preserves that boundary and isolates via `GEMINI_HOME` in env.
  const args = ctx ? ctx.buildCliArgs(baseArgs) : baseArgs;
  const { env, unsetEnv } = resolveExecutionEnv(opts);

  const authAbort = new AbortController();
  let authPromptDetected = false;
  const result = await execCliQuick(binary, args, 25_000, {
    cwd,
    env,
    unsetEnv,
    signal: authAbort.signal,
    onStderrChunk: (chunk) => {
      if (!authPromptDetected && AUTH_PROMPT_PATTERN.test(chunk)) {
        authPromptDetected = true;
        authAbort.abort();
      }
    },
  });

  if (authPromptDetected || AUTH_PROMPT_PATTERN.test(result.stderr)) {
    throw new AgyAuthRequiredError('AGY 尚未登录或登录已过期，请先完成官方 Google 登录');
  }

  const parsed = parseResult(result.stdout);
  if (result.exitCode !== 0 || parsed?.command?.name !== command.slice(1)) {
    throw new Error(parsed?.error || result.stderr.trim() || `AGY 未返回 ${command} 的结构化结果`);
  }
  return parsed.command.data;
}

export async function runAgyCommand(
  binary: string,
  config: AdapterSessionConfig,
  command: string,
  nativeSessionId: string | null,
  signal: AbortSignal,
  opts?: AgyCommandExecutionOptions,
): Promise<AgyCliResult> {
  const slashName = extractSlashCommandName(command);
  if (
    slashName &&
    isInteractiveWorkflowSlashCommand(command, {
      includeGoal: Boolean(opts?.blockGoalAuxiliaryFallback),
    })
  ) {
    throw new AgyInteractiveWorkflowFallbackError(slashName);
  }
  const compact = command === '/compact';
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    throw new Error('AGY 原生命令需要直接配置 agy.exe');
  }
  const inputFormat = compact
    ? ['-p', command, '--output-format', 'json']
    : ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  const baseArgs = [...inputFormat, '--print-timeout', '15m', '--settings', '{"disableSlashCommands":false}'];
  if (nativeSessionId) baseArgs.push('--conversation', nativeSessionId);
  if (compact || config.permissionMode === 'plan') baseArgs.push('--mode', 'plan');
  else if (config.permissionMode === 'accept_edits') baseArgs.push('--mode', 'accept-edits');
  else if (config.permissionMode === 'auto') baseArgs.push('--mode', 'auto');
  if (config.model) baseArgs.push('--model', config.model);
  if (config.reasoningEffort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(config.reasoningEffort)) {
    baseArgs.push('--effort', config.reasoningEffort);
  }

  const args = opts?.launchContext ? opts.launchContext.buildCliArgs(baseArgs) : baseArgs;
  const { env, unsetEnv } = resolveExecutionEnv(opts);

  const authAbort = new AbortController();
  const onExternalAbort = () => authAbort.abort();
  signal.addEventListener('abort', onExternalAbort, { once: true });
  let authPromptDetected = false;

  try {
    const result = await execCliQuick(binary, args, 15 * 60_000 + 10_000, {
      cwd: config.cwd,
      signal: authAbort.signal,
      env,
      unsetEnv,
      input: compact ? undefined : JSON.stringify({ event: 'user', message: { content: command } }) + '\n',
      onStderrChunk: (chunk) => {
        if (!authPromptDetected && AUTH_PROMPT_PATTERN.test(chunk)) {
          authPromptDetected = true;
          authAbort.abort();
        }
      },
    });
    if (authPromptDetected || AUTH_PROMPT_PATTERN.test(result.stderr)) {
      throw new AgyAuthRequiredError('AGY 尚未登录或登录已过期，请先完成官方 Google 登录');
    }
    const parsed = parseResult(result.stdout);
    if (signal.aborted) throw new Error('AGY 命令已取消');
    if (result.exitCode !== 0 || !parsed || parsed.status === 'ERROR' || parsed.error) {
      throw new Error(parsed?.error || result.stderr.trim() || 'AGY 未返回命令结果');
    }
    return parsed;
  } finally {
    signal.removeEventListener('abort', onExternalAbort);
  }
}

function parseResult(stdout: string): AgyCliResult | undefined {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const data = JSON.parse(line);
      if (data?.event === 'result') return { conversation_id: data.conversation_id, ...data.result };
      if (data?.status || data?.command) return data;
    } catch {
      // CLI startup notices may precede the JSON.
    }
  }
  return undefined;
}
