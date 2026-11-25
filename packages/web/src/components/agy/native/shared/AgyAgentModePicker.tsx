import { ChevronDown, Info, Lock, Sparkles } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CapabilityDescriptor, GateState } from '../../../../lib/native-client';
import { EntityStatusBadge } from './EntityStatusBadge';

export interface AgyModeOption {
  id: string;
  label: string;
  capabilityId?: string;
  commandPrefix?: string;
  placeholder: string;
  description: string;
  officialEntry: string;
  tierHint?: string;
  gate: GateState;
  sourceNote: string;
}

export const DEFAULT_AGY_MODES: ReadonlyArray<Omit<AgyModeOption, 'gate' | 'sourceNote' | 'tierHint'>> = [
  {
    id: 'normal',
    label: '普通对话',
    placeholder: '向 Antigravity 发送普通指令 · / 原生命令 · @ 引用文件',
    description: '标准 AGY 单轮与原生后台续跑对话模式，保持原生 Agent 自主编排。',
    officialEntry: '直接输入并发送',
  },
  {
    id: 'subagent',
    label: '子 Agent 委派',
    capabilityId: 'AGY-W01',
    commandPrefix: '@agent',
    placeholder: '描述需要原生子 Agent 协作的子任务…',
    description: '经原生 Agent 委派或自定义角色执行独立子任务，身份以协议或版本化记录确证。',
    officialEntry: '官方 CLI /agents 或 @agent',
  },
  {
    id: 'swarm',
    label: 'Swarm 协作',
    capabilityId: 'AGY-W04',
    commandPrefix: '/swarm',
    placeholder: '输入 Swarm 协作目标（仅点击发送后由原生命令路由提交）…',
    description: '由原生 Coordinator 协调实名 Workers 与 Verifier 并行推进；Board 按实际 feed 展示。',
    officialEntry: '官方 CLI /swarm <task> · /swarm board',
  },
  {
    id: 'boost',
    label: 'Boost 深度验证',
    capabilityId: 'AGY-W06',
    commandPrefix: '/boost',
    placeholder: '输入需要深度实现、挑战与独立验证的任务目标…',
    description: '按需触发原生实现、挑战、修复与验证流程；阶段区块仅在收到阶段证据后展示。',
    officialEntry: '官方 CLI /boost <task>',
  },
  {
    id: 'teamwork',
    label: 'Teamwork 项目',
    capabilityId: 'AGY-W07',
    commandPrefix: '/teamwork',
    placeholder: '输入 Teamwork 项目愿景，原生端将进入访谈与 Prompt 审阅…',
    description: '通过原生访谈收集约束、生成 Prompt Artifact 并推进里程碑；审批走原生边界。',
    officialEntry: '官方 App / CLI /teamwork <goal>',
  },
  {
    id: 'dynamic',
    label: 'Dynamic Workflow',
    capabilityId: 'AGY-W08',
    commandPrefix: '/run-workflow',
    placeholder: '输入需由原生动态工作流编排的多阶段任务…',
    description: '先审阅原生脚本与权限，再按已证实的 phase/edge 观察并行执行与结构化结果。',
    officialEntry: '官方 App / CLI /run-workflow <task>',
  },
  {
    id: 'goal',
    label: 'Goal 持续推进',
    capabilityId: 'AGY-W09',
    commandPrefix: '/goal',
    placeholder: '输入需持续核验直至达成的 Goal 目标…',
    description: '在目标验证完成前持续推进，复用同一 live runtime，不另起脱离会话的进程。',
    officialEntry: '官方 CLI /goal <objective>',
  },
  {
    id: 'schedule',
    label: 'Schedule 定时唤醒',
    capabilityId: 'AGY-W10',
    commandPrefix: '/schedule',
    placeholder: '输入时间与任务，例如：5 分钟后复查构建状态…',
    description: '由 AGY 原生在同会话按时唤醒并记录每次 occurrence，不用 HM 调度替代。',
    officialEntry: '官方 CLI /schedule <when> <task>',
  },
];

export function resolveAgyModeOptions(
  capabilities: readonly CapabilityDescriptor[],
  profileVerified: boolean,
): AgyModeOption[] {
  const byId = new Map(capabilities.map((cap) => [cap.id, cap]));
  return DEFAULT_AGY_MODES.map((base) => {
    if (base.id === 'normal') {
      return {
        ...base,
        gate: 'available',
        sourceNote: 'ACP v1 基础能力',
      };
    }
    const cap = base.capabilityId ? byId.get(base.capabilityId) : undefined;
    if (!profileVerified) {
      return {
        ...base,
        gate: 'not_tested',
        tierHint: cap?.tierHint,
        sourceNote: '当前 Profile 尚未通过官方登录验证（可浏览说明，暂不可运行）',
      };
    }
    if (!cap) {
      return {
        ...base,
        gate: 'unknown',
        sourceNote: '当前绑定尚未收到该模式的广告或能力描述',
      };
    }
    const sourceNote =
      cap.advertised === true
        ? `当前会话已广告 · rev #${cap.snapshotRevision}`
        : cap.advertised === false
          ? `当前会话未广告 · rev #${cap.snapshotRevision}`
          : `状态来自能力目录 · rev #${cap.snapshotRevision}`;
    return {
      ...base,
      gate: cap.launch,
      tierHint: cap.tierHint,
      sourceNote,
    };
  });
}

export interface AgyAgentModePickerProps {
  selectedModeId: string;
  capabilities: readonly CapabilityDescriptor[];
  profileVerified?: boolean;
  disabled?: boolean;
  onSelectMode: (mode: AgyModeOption) => void;
}

/**
 * Unified Agent Mode Picker (09_Frontend_Design.md).
 * - Single control in composer displaying normal, subagent, and verified workflow modes.
 * - Shows plan/tier hint, gate state, and status source; expands description on demand.
 * - Preserves draft & attachments when switching; NEVER executes on select.
 * - Unverified profiles or gated modes remain inspectable but non-runnable with clear official entry hints.
 */
export function AgyAgentModePicker({
  selectedModeId,
  capabilities,
  profileVerified = false,
  disabled = false,
  onSelectMode,
}: AgyAgentModePickerProps) {
  const [open, setOpen] = useState(false);
  const [expandedInfoId, setExpandedInfoId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const options = useMemo(
    () => resolveAgyModeOptions(capabilities, profileVerified),
    [capabilities, profileVerified],
  );
  const activeOption = options.find((opt) => opt.id === selectedModeId) ?? options[0]!;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="relative inline-flex" data-testid="agy-agent-mode-picker">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)] disabled:opacity-45"
      >
        <Sparkles size={11.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />
        <span>模式: {activeOption.label}</span>
        {activeOption.gate !== 'available' && (
          <Lock size={10} className="text-[var(--accent-clay)]" aria-hidden="true" />
        )}
        <ChevronDown size={11} className="text-[var(--text-muted)]" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={menuId}
          role="listbox"
          aria-label="选择 AGY 工作模式"
          className="animate-fade-up absolute bottom-full left-0 z-50 mb-2 w-[310px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl p-1.5"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            boxShadow: 'var(--shadow-float)',
          }}
        >
          <div className="flex items-center justify-between px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <span>AGY Agent 模式（切换保留草稿）</span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
              className="cursor-pointer text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              关闭
            </button>
          </div>
          <div className="max-h-[280px] space-y-1 overflow-y-auto p-0.5">
            {options.map((opt) => {
              const selected = opt.id === activeOption.id;
              const runnable = opt.gate === 'available';
              const infoExpanded = expandedInfoId === opt.id;
              return (
                <div
                  key={opt.id}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={!runnable}
                  className="rounded-xl border p-2 text-[11.5px]"
                  style={{
                    backgroundColor: selected ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    borderColor: selected ? 'var(--border-focus)' : 'var(--border-hairline)',
                  }}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <button
                      type="button"
                      disabled={!runnable}
                      onClick={() => {
                        if (!runnable) return;
                        onSelectMode(opt);
                        setOpen(false);
                        buttonRef.current?.focus();
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left disabled:cursor-not-allowed disabled:opacity-65"
                    >
                      <span className="truncate font-medium text-[var(--text-primary)]">
                        {opt.label}
                      </span>
                      {opt.tierHint && (
                        <span className="shrink-0 rounded bg-[var(--bg-surface)] px-1 py-0.2 font-mono-code text-[9.5px] text-[var(--text-muted)]">
                          {opt.tierHint}
                        </span>
                      )}
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <EntityStatusBadge kind="gate" gate={opt.gate} compact />
                      <button
                        type="button"
                        aria-label={`展开 ${opt.label} 说明`}
                        aria-expanded={infoExpanded}
                        onClick={() => setExpandedInfoId(infoExpanded ? null : opt.id)}
                        className="cursor-pointer rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        <Info size={12} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">{opt.sourceNote}</div>
                  {infoExpanded && (
                    <div className="mt-1.5 space-y-1 border-t border-[var(--border-hairline)] pt-1.5 text-[11px] text-[var(--text-secondary)]">
                      <p>{opt.description}</p>
                      <p className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                        官方入口：{opt.officialEntry}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
