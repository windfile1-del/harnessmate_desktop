import type { HarnessCommandInfo, HarnessKind, Session } from '@harnessmate/protocol';
import { inspectAgyCommand } from '../harnesses/agy-commands.js';
import { AgyAdapter } from '../harnesses/agy/agy-driver.js';
import type { AgyLaunchContext } from '../harnesses/agy/agy-launch-context.js';
import { formatAgyUsageSummary } from '../harnesses/agy/agy-usage.js';
import { execCliQuick, resolveBinary } from '../harnesses/process.js';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type { NativeSkill } from '../harnesses/types.js';
import type { UsageService } from './usage-service.js';

export function listHarnessCommands(kind: HarnessKind, agyDesktop: boolean): HarnessCommandInfo[] {
  if (kind !== 'codex' && kind !== 'claude' && kind !== 'agy') return [];
  const commands: HarnessCommandInfo[] = [
    { command: 'model', description: '查看列表或切换当前会话的模型', argumentHint: '[模型 ID | default]' },
    { command: 'plan', description: '进入计划模式，或用 off 退出', argumentHint: '[任务 | off]' },
    { command: 'usage', description: '查看底层 CLI 提供的用量或额度' },
  ];
  if (!agyDesktop) {
    commands.push(
      { command: 'compact', description: '压缩原生会话的模型上下文',
        ...(kind === 'claude' ? { argumentHint: '[摘要重点]' } : {}) },
      { command: 'goal', description: '查看或设置原生目标',
        argumentHint: kind === 'agy' ? '<目标>' : '[目标 | status | pause | resume | clear]' },
      { command: 'plugin', description: '列出或安装底层 CLI 插件',
        argumentHint: kind === 'claude' ? '[list | install ID | reload]' : '[list | install ID]' },
      { command: 'skills', description: '列出此工作区可调用的原生技能' },
      { command: 'skill', description: '调用指定技能', argumentHint: '<名称> [参数]' },
    );
  }
  return commands;
}

export class HarnessCommandTools {
  constructor(
    private readonly getUsageService: () => UsageService | undefined,
    private readonly binaryOverrides: Record<string, string>,
    private readonly registry?: HarnessRegistry,
  ) {}

  private async resolveAgyLaunchContext(harnessId?: string): Promise<AgyLaunchContext | undefined> {
    const adapter = this.registry?.get(harnessId ?? 'agy') ?? this.registry?.get('agy');
    if (adapter instanceof AgyAdapter) {
      return adapter.getLaunchContext();
    }
    return undefined;
  }

  async getUsage(session: Session): Promise<string> {
    if (session.harnessKind === 'agy') {
      const launchContext = await this.resolveAgyLaunchContext(session.harnessId);
      const binary = await this.getBinary('agy', launchContext?.binaryPath);
      const data = await inspectAgyCommand(binary, session.cwd, '/usage', { launchContext });
      return formatAgyUsageSummary(data);
    }
    const service = this.getUsageService();
    if (!service) throw new Error('额度服务已停用');
    const usage = await service.collectInstanceUsage(session.harnessId);
    const windows = usage.rateLimits.map((item) =>
      `${item.label} · 剩余 ${(100 - item.usedPercent).toFixed(1)}%` +
      (item.resetsAt ? ` · ${new Date(item.resetsAt).toLocaleString()} 重置` : ''));
    return [...windows, ...(windows.length ? [] : [`${usage.displayName} 未返回订阅额度`]),
      `HarnessMate 已记录 ${usage.localInputTokens} 输入 / ${usage.localOutputTokens} 输出 tokens`,
      ...(usage.error ? [usage.error] : []),
    ].join('\n');
  }

  async listAgySkills(cwd: string, harnessId?: string): Promise<NativeSkill[]> {
    const launchContext = await this.resolveAgyLaunchContext(harnessId);
    const binary = await this.getBinary('agy', launchContext?.binaryPath);
    const data = (await inspectAgyCommand(binary, cwd, '/skills', {
      launchContext,
    })) as { skills?: NativeSkill[] };
    return data?.skills ?? [];
  }

  async runPluginCommand(session: Session, arg: string): Promise<string> {
    const kind = session.harnessKind;
    const [verb, target, ...extra] = arg.split(/\s+/);
    const executable = await this.getBinary(kind);
    let args: string[];
    if (!arg || arg === 'list') {
      args = ['plugin', 'list', '--json'];
    } else if (verb === 'install' && target && !extra.length && /^[a-z0-9][a-z0-9_.-]*(@[a-z0-9][a-z0-9_.-]*)?$/i.test(target)) {
      args = ['plugin', kind === 'codex' ? 'add' : 'install', target];
    } else {
      throw new Error('用法 /plugin list 或 /plugin install <插件[@市场]>');
    }
    const result = await execCliQuick(executable, args, 60_000, { cwd: session.cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || '插件命令执行失败');
    return result.stdout.trim() || result.stderr.trim() || '插件命令完成';
  }

  private async getBinary(kind: string, overridePath?: string): Promise<string> {
    const binary = await resolveBinary(kind, overridePath ?? this.binaryOverrides[kind]);
    if (!binary) throw new Error(`未找到 ${kind} CLI`);
    return binary;
  }
}
