import type {
  ActivityOrigin,
  ActivityStatus,
  AgentForeground,
  AgentLineage,
  Blocking,
  EvidenceDto,
  GateState,
  NativeRequestReceiptState,
  NativeRuntimeStatus,
  NativeWorkKind,
  Observed,
  WorkOutcome,
  WorkState,
} from '../../../../lib/native-client';

/**
 * Versioned Status Dictionary shared across all AGY Native Workbench views,
 * badges, timelines, and mode pickers (09_Frontend_Design.md).
 *
 * Color is strictly auxiliary: every status carries an explicit semantic label,
 * accessible ariaLabel, and concise icon key.
 */
export const STATUS_DICTIONARY_VERSION = 1 as const;

export type SemanticTone = 'indigo' | 'emerald' | 'star' | 'rose' | 'clay' | 'muted';

export interface StatusMeta {
  label: string;
  shortLabel: string;
  tone: SemanticTone;
  ariaLabel: string;
  description: string;
  isActive?: boolean;
}

export const EMPTY_STATE_COPY = {
  noActivityObserved: '尚未观察到活动',
  sourceNotProvided: '该来源不提供',
  emptyListNotStopped: '空列表仅表示当前未观察到条目，不能证明后台任务已停止。',
} as const;

export const RUNTIME_STATUS_DICTIONARY: Record<NativeRuntimeStatus, StatusMeta> = {
  attached: {
    label: '原生连接正常',
    shortLabel: '已连接',
    tone: 'emerald',
    ariaLabel: 'AGY 原生运行时已连接',
    description: '实时协议流已附着到当前绑定 generation。',
    isActive: true,
  },
  reconciling: {
    label: '正在校准状态',
    shortLabel: '校准中',
    tone: 'star',
    ariaLabel: 'AGY 原生运行时正在重连并校准状态',
    description: '重连或恢复中，等待新的原生观测确认，未决项保留最后观测。',
    isActive: true,
  },
  disconnected: {
    label: '观测连接已断开',
    shortLabel: '已断开',
    tone: 'rose',
    ariaLabel: 'AGY 原生运行时连接已断开',
    description: '观测连接已结束，不能直接推断后台子进程已按逻辑取消。',
    isActive: false,
  },
};

export const ACTIVITY_STATUS_DICTIONARY: Record<ActivityStatus, StatusMeta> = {
  starting: {
    label: '正在启动',
    shortLabel: '启动中',
    tone: 'indigo',
    ariaLabel: '活动正在启动',
    description: '已收到启动帧，等待后续执行证据。',
    isActive: true,
  },
  running: {
    label: '运行中',
    shortLabel: '运行中',
    tone: 'indigo',
    ariaLabel: '活动正在运行',
    description: '已证实存在活跃的前台或原生活动。',
    isActive: true,
  },
  waiting_background: {
    label: '等待后台任务',
    shortLabel: '等待后台',
    tone: 'star',
    ariaLabel: '正在等待有限后台任务完成',
    description: '主响应已返回，但存在阻塞轮次的有限后台任务，无需补发消息。',
    isActive: true,
  },
  requires_action: {
    label: '等待用户处理',
    shortLabel: '需操作',
    tone: 'star',
    ariaLabel: '活动正在等待权限确认或问答输入',
    description: '存在待处理的原生权限请求或结构化问题。',
    isActive: true,
  },
  quiescent: {
    label: '静默待唤醒',
    shortLabel: '待唤醒',
    tone: 'muted',
    ariaLabel: '活动当前静默，可由原生事件再次唤醒',
    description: '当前无活跃前台帧，可能由后续原生事件继续推进。',
  },
  cancelling: {
    label: '正在取消',
    shortLabel: '取消中',
    tone: 'clay',
    ariaLabel: '已发送原生取消信号，等待原生确认',
    description: '已发出取消请求，等待原生端终态证据。',
    isActive: true,
  },
  reconciling: {
    label: '状态校准中',
    shortLabel: '校准中',
    tone: 'star',
    ariaLabel: '活动正在校准恢复状态',
    description: '连接变动后正在与最新原生快照对齐。',
    isActive: true,
  },
  finished: {
    label: '已结束',
    shortLabel: '已结束',
    tone: 'emerald',
    ariaLabel: '活动已结束',
    description: '收到原生终态证据；具体成败以独立结果字段为准。',
  },
  failed: {
    label: '执行失败',
    shortLabel: '失败',
    tone: 'rose',
    ariaLabel: '活动执行失败',
    description: '收到原生失败终态。',
  },
  cancelled: {
    label: '已取消',
    shortLabel: '已取消',
    tone: 'clay',
    ariaLabel: '活动已取消',
    description: '已收到原生取消终态。',
  },
  unknown: {
    label: '状态未确认',
    shortLabel: '未知',
    tone: 'muted',
    ariaLabel: '活动状态未确认',
    description: '缺少足够的协议或快照证据以确认当前状态。',
  },
};

export const WORK_STATE_DICTIONARY: Record<WorkState, StatusMeta> = {
  queued: {
    label: '排队中',
    shortLabel: '排队',
    tone: 'muted',
    ariaLabel: '工作项排队中',
    description: '已观测到创建或排队，尚未开始执行。',
    isActive: true,
  },
  running: {
    label: '运行中',
    shortLabel: '运行中',
    tone: 'indigo',
    ariaLabel: '工作项正在运行',
    description: '存在有效证据确认该工作项正在执行。',
    isActive: true,
  },
  waiting: {
    label: '等待中',
    shortLabel: '等待',
    tone: 'star',
    ariaLabel: '工作项等待外部或定时触发',
    description: '等待子任务、定时触发或依赖条件完成。',
    isActive: true,
  },
  requires_action: {
    label: '需操作',
    shortLabel: '需操作',
    tone: 'star',
    ariaLabel: '工作项等待用户审批或交互',
    description: '需要用户在原生权限或问题卡片上做出选择。',
    isActive: true,
  },
  finished: {
    label: '运行结束',
    shortLabel: '结束',
    tone: 'emerald',
    ariaLabel: '工作项运行已结束',
    description: '可观察运行终态；成功与否由 outcome 单独标识。',
  },
  failed: {
    label: '失败',
    shortLabel: '失败',
    tone: 'rose',
    ariaLabel: '工作项执行失败',
    description: '收到明确的失败证据。',
  },
  cancelled: {
    label: '已取消',
    shortLabel: '已取消',
    tone: 'clay',
    ariaLabel: '工作项已取消',
    description: '收到明确的原生取消终态。',
  },
  unknown: {
    label: '状态未知',
    shortLabel: '未知',
    tone: 'muted',
    ariaLabel: '工作项状态未知',
    description: '当前无权威状态证据，不推断为成功或已停止。',
  },
};

export const WORK_OUTCOME_DICTIONARY: Record<WorkOutcome, StatusMeta> = {
  succeeded: {
    label: '已证实成功',
    shortLabel: '成功',
    tone: 'emerald',
    ariaLabel: '工作结果已证实成功',
    description: '原生结果明确证实成功完成。',
  },
  failed: {
    label: '结果失败',
    shortLabel: '失败',
    tone: 'rose',
    ariaLabel: '工作结果失败',
    description: '原生结果明确返回失败。',
  },
  cancelled: {
    label: '已中止',
    shortLabel: '中止',
    tone: 'clay',
    ariaLabel: '工作结果已中止',
    description: '原生结果明确返回取消。',
  },
};

export const AGENT_FOREGROUND_DICTIONARY: Record<AgentForeground, StatusMeta> = {
  running: {
    label: '活跃运行中',
    shortLabel: '运行中',
    tone: 'indigo',
    ariaLabel: 'Agent 正在前台运行',
    description: '该原生 Agent 当前处于活跃执行状态。',
    isActive: true,
  },
  requires_action: {
    label: '等待交互',
    shortLabel: '需操作',
    tone: 'star',
    ariaLabel: 'Agent 正在等待审批或回答',
    description: '该 Agent 发出了待处理权限或问题请求。',
    isActive: true,
  },
  idle: {
    label: '空闲（可再唤醒）',
    shortLabel: '空闲',
    tone: 'muted',
    ariaLabel: 'Agent 当前空闲，不等同于任务成功',
    description: '空闲表示当前无活跃轮次，可被原生事件再次唤醒，不计入成功进度。',
  },
  unknown: {
    label: '状态未知',
    shortLabel: '未知',
    tone: 'muted',
    ariaLabel: 'Agent 状态未知',
    description: '未获得该 Agent 的实时前台状态证据。',
  },
};

export const BLOCKING_DICTIONARY: Record<Blocking, StatusMeta> = {
  confirmed_blocking: {
    label: '阻塞当前轮次',
    shortLabel: '阻塞轮次',
    tone: 'star',
    ariaLabel: '已证实阻塞当前用户轮次',
    description: '此有限任务在完成前保持当前轮次等待并持有保活。',
  },
  detached: {
    label: '独立后台',
    shortLabel: '已分离',
    tone: 'indigo',
    ariaLabel: '独立后台运行，不阻塞主聊天',
    description: '不阻塞主聊天输入，在 Runtime Center 独立追踪。',
  },
  unknown: {
    label: '阻塞性未知',
    shortLabel: '阻塞未知',
    tone: 'muted',
    ariaLabel: '是否阻塞主轮次尚待确认',
    description: '缺少明确证据判断该任务是否阻塞主轮次。',
  },
};

export const GATE_STATE_DICTIONARY: Record<GateState, StatusMeta> = {
  available: {
    label: '已验证可用',
    shortLabel: '可用',
    tone: 'emerald',
    ariaLabel: '当前绑定已验证该能力可用',
    description: '当前会话与账户已广告并满足调用边界。',
  },
  unknown: {
    label: '尚未确认',
    shortLabel: '未知',
    tone: 'muted',
    ariaLabel: '能力可用性未知',
    description: '当前会话尚未收到该能力的广播或实证。',
  },
  unsupported: {
    label: '当前不支持',
    shortLabel: '不支持',
    tone: 'rose',
    ariaLabel: '当前版本或协议不支持此能力',
    description: '当前协议或目标环境明确不支持此操作。',
  },
  upstream_limited: {
    label: '上游协议受限',
    shortLabel: '上游受限',
    tone: 'clay',
    ariaLabel: '官方端支持但 ACP 上游未暴露完整数据或控制',
    description: '官方 App/CLI 具备该功能，但当前 ACP 流未暴露对应 feed 或动作。',
  },
  not_tested: {
    label: '待真机验证',
    shortLabel: '待验证',
    tone: 'star',
    ariaLabel: '尚未在真机授权环境验证',
    description: '仅具备规范或离线样本，正式控制等待真机实测解锁。',
  },
};

export const RECEIPT_STATE_DICTIONARY: Record<NativeRequestReceiptState, StatusMeta> = {
  pending: {
    label: '待处理',
    shortLabel: '待处理',
    tone: 'star',
    ariaLabel: '原生请求等待用户响应',
    description: '请在有效连接周期内选择官方提供的合法选项。',
    isActive: true,
  },
  claimed: {
    label: '提交中',
    shortLabel: '提交中',
    tone: 'indigo',
    ariaLabel: '正在提交原生响应',
    description: '已通过防重放 CAS 锁，正在写入响应。',
    isActive: true,
  },
  response_written: {
    label: '已发送，等待原生确认',
    shortLabel: '已写入响应',
    tone: 'indigo',
    ariaLabel: '响应已写入原生连接，等待对端后续帧确认',
    description: 'JSON-RPC 响应已写出，对端实际执行由后续原生帧确认。',
  },
  cancelled: {
    label: '已取消',
    shortLabel: '已取消',
    tone: 'clay',
    ariaLabel: '原生请求已取消',
    description: '请求已由用户或对端取消。',
  },
  expired: {
    label: '已过期',
    shortLabel: '已过期',
    tone: 'muted',
    ariaLabel: '原生请求已超过截止时间',
    description: '请求已超时失效，不可重放。',
  },
  connection_lost: {
    label: '连接已丢失',
    shortLabel: '连接丢失',
    tone: 'rose',
    ariaLabel: '原连接已断开，旧审批不可重放',
    description: '原连接断开导致该请求失效；重连后需等待对端发出新请求。',
  },
  delivery_unknown: {
    label: '送达未确认',
    shortLabel: '送达未知',
    tone: 'clay',
    ariaLabel: '响应写出后进程中断，送达结果未知',
    description: '写出响应后发生中断，保留只读收据且不会自动重放授权。',
  },
};

export const ACTIVITY_ORIGIN_LABELS: Record<ActivityOrigin, string> = {
  user_turn: '用户轮次',
  native_continuation: '原生续跑',
  native_task: '原生任务',
  recovery: '恢复对齐',
};

export const WORK_KIND_LABELS: Record<NativeWorkKind, string> = {
  finite_command: '有限后台命令',
  daemon: '常驻进程 (Daemon)',
  subagent: '原生子 Agent',
  schedule: '定时唤醒 (Schedule)',
  workflow_step: '工作流步骤',
  unknown: '未分类工作项',
};

export const AGENT_LINEAGE_LABELS: Record<AgentLineage, StatusMeta> = {
  confirmed: {
    label: '身份已确证',
    shortLabel: '已确证',
    tone: 'emerald',
    ariaLabel: '父子归属关系已有协议或版本快照确证',
    description: '已通过同连接稳定 ID 或已验证记录确认父子归属。',
  },
  unresolved: {
    label: '身份待确认',
    shortLabel: '待确认',
    tone: 'star',
    ariaLabel: '仅观察到委派，子 Agent 身份尚未确认',
    description: '仅观察到启动事实，未获稳定子身份前禁用子操作。',
  },
  conflicting: {
    label: '归属冲突',
    shortLabel: '冲突',
    tone: 'rose',
    ariaLabel: '观测到冲突的父子归属关系',
    description: '保留原始诊断记录，不建立未证实父边或控制。',
  },
};

export const EVIDENCE_SOURCE_LABELS: Record<EvidenceDto['sourceKind'], string> = {
  live_protocol: 'Live ACP 协议帧',
  native_snapshot: '只读原生快照',
  host_observation: '宿主观测',
  replay: '回放样本 (Replay)',
};

export function resolveObservedWorkMeta(observed: Observed<WorkState>): StatusMeta {
  if (observed.kind === 'known') {
    return WORK_STATE_DICTIONARY[observed.value];
  }
  if (observed.kind === 'stale') {
    const lastMeta = observed.last ? WORK_STATE_DICTIONARY[observed.last] : null;
    return {
      label: lastMeta ? `最后观测：${lastMeta.shortLabel}（已过期）` : '最后观测已过期',
      shortLabel: lastMeta ? `旧:${lastMeta.shortLabel}` : '已过期',
      tone: 'clay',
      ariaLabel: `状态已过期，原因 ${observed.reasonCode}`,
      description: `当前观测已过期 (${observed.reasonCode})，不将其等同于正在运行或已完成。`,
    };
  }
  return {
    ...WORK_STATE_DICTIONARY.unknown,
    ariaLabel: `工作项状态未知，原因 ${observed.reasonCode}`,
    description: `状态未知 (${observed.reasonCode})。`,
  };
}

export function resolveObservedForegroundMeta(observed: Observed<AgentForeground>): StatusMeta {
  if (observed.kind === 'known') {
    return AGENT_FOREGROUND_DICTIONARY[observed.value];
  }
  if (observed.kind === 'stale') {
    const lastMeta = observed.last ? AGENT_FOREGROUND_DICTIONARY[observed.last] : null;
    return {
      label: lastMeta ? `最后观测：${lastMeta.shortLabel}（已过期）` : '最后观测已过期',
      shortLabel: lastMeta ? `旧:${lastMeta.shortLabel}` : '已过期',
      tone: 'clay',
      ariaLabel: `Agent 前台状态已过期，原因 ${observed.reasonCode}`,
      description: `Agent 观测已过期 (${observed.reasonCode})。`,
    };
  }
  return {
    ...AGENT_FOREGROUND_DICTIONARY.unknown,
    ariaLabel: `Agent 状态未知，原因 ${observed.reasonCode}`,
  };
}

export function toneStyle(tone: SemanticTone): { color: string; backgroundColor: string; borderColor: string } {
  switch (tone) {
    case 'indigo':
      return {
        color: 'var(--accent-indigo)',
        backgroundColor: 'var(--accent-indigo-soft)',
        borderColor: 'color-mix(in srgb, var(--accent-indigo) 32%, transparent)',
      };
    case 'emerald':
      return {
        color: 'var(--accent-emerald)',
        backgroundColor: 'var(--accent-emerald-soft)',
        borderColor: 'color-mix(in srgb, var(--accent-emerald) 32%, transparent)',
      };
    case 'star':
      return {
        color: 'var(--accent-star)',
        backgroundColor: 'var(--accent-star-soft)',
        borderColor: 'color-mix(in srgb, var(--accent-star) 35%, transparent)',
      };
    case 'rose':
      return {
        color: 'var(--accent-rose)',
        backgroundColor: 'var(--accent-rose-soft)',
        borderColor: 'color-mix(in srgb, var(--accent-rose) 35%, transparent)',
      };
    case 'clay':
      return {
        color: 'var(--accent-clay)',
        backgroundColor: 'var(--accent-clay-soft)',
        borderColor: 'color-mix(in srgb, var(--accent-clay) 35%, transparent)',
      };
    default:
      return {
        color: 'var(--text-secondary)',
        backgroundColor: 'var(--bg-elevated)',
        borderColor: 'var(--border-hairline)',
      };
  }
}
