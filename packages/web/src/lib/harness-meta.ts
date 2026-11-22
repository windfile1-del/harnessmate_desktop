import type { HarnessKind, PermissionMode } from '@harnessmate/protocol';

export interface HarnessVisualMeta {
  shortLabel: string;
  accentColor: string;
  softBg: string;
  tagline: string;
}

export const HARNESS_META: Record<HarnessKind, HarnessVisualMeta> = {
  codex: {
    shortLabel: 'Codex',
    accentColor: 'var(--accent-emerald)',
    softBg: 'var(--accent-emerald-soft)',
    tagline: 'OpenAI Codex · App Server',
  },
  agy: {
    shortLabel: 'AGY',
    accentColor: 'var(--accent-indigo)',
    softBg: 'var(--accent-indigo-soft)',
    tagline: 'Antigravity · Native ACP',
  },
  claude: {
    shortLabel: 'Claude',
    accentColor: 'var(--accent-clay)',
    softBg: 'var(--accent-clay-soft)',
    tagline: 'Claude Code · Stream JSON',
  },
  acp: {
    shortLabel: 'ACP',
    accentColor: 'var(--accent-star)',
    softBg: 'var(--accent-star-soft)',
    tagline: 'Custom ACP Agent',
  },
};

export const PERMISSION_MODE_LABELS: Record<PermissionMode, { label: string; desc: string }> = {
  plan: { label: 'Plan', desc: '只读分析与规划，不修改文件' },
  manual: { label: 'Manual', desc: '高敏感或未信任操作逐项审批' },
  accept_edits: { label: 'Accept Edits', desc: '允许工作区编辑，命令需审批' },
  auto: { label: 'Auto', desc: '自动批准沙箱内工具调用' },
};

export function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
