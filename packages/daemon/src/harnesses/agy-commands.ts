import { execCliQuick } from './process.js';
import type { AdapterSessionConfig } from './types.js';

interface AgyCliResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  command?: { name?: string; data?: unknown };
}

export async function inspectAgyCommand(binary: string, cwd: string, command: '/usage' | '/skills'): Promise<unknown> {
  const result = await execCliQuick(binary, ['-p', command, '--output-format', 'json', '--print-timeout', '20s'],
    25_000, { cwd });
  const parsed = parseResult(result.stdout);
  if (result.exitCode !== 0 || parsed?.command?.name !== command.slice(1)) {
    throw new Error(parsed?.error || result.stderr.trim() || `AGY 未返回 ${command} 的结构化结果`);
  }
  return parsed.command.data;
}

export async function runAgyCommand(
  binary: string, config: AdapterSessionConfig, command: string, nativeSessionId: string | null, signal: AbortSignal,
): Promise<AgyCliResult> {
  const compact = command === '/compact';
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    throw new Error('AGY 原生命令需要直接配置 agy.exe');
  }
  const inputFormat = compact ? ['-p', command, '--output-format', 'json']
    : ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  const args = [...inputFormat, '--print-timeout', '15m', '--settings', '{"disableSlashCommands":false}'];
  if (nativeSessionId) args.push('--conversation', nativeSessionId);
  if (compact || config.permissionMode === 'plan') args.push('--mode', 'plan');
  else if (config.permissionMode === 'accept_edits') args.push('--mode', 'accept-edits');
  else if (config.permissionMode === 'auto') args.push('--mode', 'auto');
  if (config.model) args.push('--model', config.model);
  if (config.reasoningEffort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(config.reasoningEffort)) {
    args.push('--effort', config.reasoningEffort);
  }
  const result = await execCliQuick(binary, args, 15 * 60_000 + 10_000, {
    cwd: config.cwd, signal,
    input: compact ? undefined : JSON.stringify({ event: 'user', message: { content: command } }) + '\n',
  });
  const parsed = parseResult(result.stdout);
  if (signal.aborted) throw new Error('AGY 命令已取消');
  if (result.exitCode !== 0 || !parsed || parsed.status === 'ERROR' || parsed.error) {
    throw new Error(parsed?.error || result.stderr.trim() || 'AGY 未返回命令结果');
  }
  return parsed;
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
