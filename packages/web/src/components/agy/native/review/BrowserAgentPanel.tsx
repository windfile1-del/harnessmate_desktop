import { ArrowUpRight, Camera, Globe, Lock, Terminal } from 'lucide-react';
import type { NativeAgentId } from '../../../../lib/native-client';
import { CapabilityUnavailable, toneStyle } from '../shared';
import type { BrowserObservationView, BrowserRuntimeSurfaceKind } from './types';

export const AGY_BROWSER_DOC_URL = 'https://antigravity.google/docs/browser/';
export const AGY_BROWSER_RECORDINGS_DOC_URL = 'https://antigravity.google/docs/ide/browser-recordings/';

const SURFACE_META: Record<
  BrowserRuntimeSurfaceKind,
  { label: string; tone: 'indigo' | 'emerald' | 'star' | 'muted'; note: string }
> = {
  app_embedded_browser: {
    label: 'Antigravity App 内嵌浏览器 (App-only)',
    tone: 'star',
    note: '个人 App v2.30+ 内嵌浏览器属于 App-only 交互体验；HarnessMate 不复刻内嵌浏览器控制，仅只读呈现观测记录。',
  },
  cli_chrome_mcp: {
    label: 'CLI / Chrome DevTools MCP',
    tone: 'indigo',
    note: '通过独立 Chrome DevTools MCP 工具执行浏览操作，遵循普通工具审批边界，不伪造宿主内嵌浏览器。',
  },
  enterprise_chrome_mcp: {
    label: '企业 Chrome MCP（受策略约束）',
    tone: 'emerald',
    note: '受企业组织与浏览器管理员策略约束的 Chrome 144+ MCP 通道。',
  },
  unknown: {
    label: '未观测到 Browser Agent 通道',
    tone: 'muted',
    note: '尚未收到结构化的 App 内嵌浏览器或 Chrome MCP 工具观测帧。',
  },
};

export interface BrowserAgentPanelProps {
  readonly observation?: BrowserObservationView | null;
  readonly onRefresh?: () => void;
  readonly onJumpToChildAgent?: (agentId: NativeAgentId) => void;
}

export function BrowserAgentPanel({
  observation,
  onRefresh,
  onJumpToChildAgent,
}: BrowserAgentPanelProps) {
  const surface = observation?.surface ?? 'unknown';
  const meta = SURFACE_META[surface];

  return (
    <div data-testid="np14-browser-agent-panel" className="space-y-3 text-[12px]">
      <section className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Globe size={14} className="text-[var(--accent-indigo)]" aria-hidden="true" />
            <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
              Browser Agent 运行时观测 (AGY-W16)
            </h3>
          </div>
          <span
            data-testid="np14-browser-surface-badge"
            className="rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
            style={toneStyle(meta.tone)}
          >
            {meta.label}
          </span>
        </div>

        <p className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{meta.note}</p>

        <CapabilityUnavailable
          title="不复刻 AGY App 内嵌浏览器交互控制"
          gate="unsupported"
          capabilityId="AGY-W16"
          reason={
            observation?.officialAppGuide ??
            'App 内嵌浏览器属于官方 Antigravity App 独占交互能力；CLI/企业场景通过 Chrome MCP 工具审批运行。HarnessMate 仅提供受控只读观测。'
          }
          officialEntryHint="官方 App 内嵌浏览器 /browser · 官方文档 browser & browser-recordings"
          officialDocUrl={AGY_BROWSER_DOC_URL}
          onRefresh={onRefresh}
        />

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <a
            href={AGY_BROWSER_RECORDINGS_DOC_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            <Camera size={11.5} aria-hidden="true" />
            <span>官方 Browser Recordings 指引</span>
          </a>
        </div>
      </section>

      <section
        aria-label="Browser Agent 角色"
        className="space-y-2 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3"
      >
        <h4 className="text-[12px] font-semibold text-[var(--text-primary)]">
          Browser 子 Agent 与工具角色
        </h4>
        {!observation || observation.roles.length === 0 ? (
          <p className="text-[11.5px] text-[var(--text-muted)]">尚未观察到 Browser Agent 角色。</p>
        ) : (
          <ul className="space-y-1.5">
            {observation.roles.map((role) => (
              <li
                key={role.roleId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-[var(--text-primary)]">{role.label}</span>
                    <span
                      className="rounded-full border px-1.5 py-0.5 text-[10px]"
                      style={toneStyle(role.lineage === 'confirmed' ? 'emerald' : 'clay')}
                    >
                      {role.lineage === 'confirmed' ? '已证实归属' : '归属未证实'}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                    通道: {role.surface} · 状态: {role.state}
                  </div>
                </div>
                {role.agentId && role.lineage === 'confirmed' && onJumpToChildAgent && (
                  <button
                    type="button"
                    onClick={() => onJumpToChildAgent(role.agentId!)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[10.5px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
                  >
                    <span>查看子 Agent</span>
                    <ArrowUpRight size={11} aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label="Browser 脱敏操作日志"
        className="space-y-2 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Terminal size={13} className="text-[var(--accent-indigo)]" aria-hidden="true" />
            <h4 className="text-[12px] font-semibold text-[var(--text-primary)]">
              受控浏览日志（已脱敏，不加载未审查外链）
            </h4>
          </div>
          {observation && observation.droppedLogCount > 0 && (
            <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
              dropped={observation.droppedLogCount}
            </span>
          )}
        </div>
        {!observation || observation.logs.length === 0 ? (
          <p className="text-[11.5px] text-[var(--text-muted)]">暂无 Browser 操作日志。</p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-auto font-mono-code text-[11px]">
            {observation.logs.map((log) => (
              <li
                key={log.seq}
                className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[var(--text-secondary)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[var(--text-primary)]">{log.actionSummary}</span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {log.redactedTargetHost ? `${log.redactedTargetHost} · ` : ''}
                    {log.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        data-testid="np14-browser-media-section"
        aria-label="Browser 截图与录像参考产物"
        className="space-y-2 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Camera size={13} className="text-[var(--accent-emerald)]" aria-hidden="true" />
            <h4 className="text-[12px] font-semibold text-[var(--text-primary)]">
              截图与录像参考产物
            </h4>
          </div>
          <span
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]"
            style={toneStyle(observation?.mediaGateEnabled ? 'emerald' : 'muted')}
          >
            <Lock size={10} aria-hidden="true" />
            <span>{observation?.mediaGateEnabled ? '媒体参考门控已开启' : '媒体门控已关闭'}</span>
          </span>
        </div>

        {!observation?.mediaGateEnabled ? (
          <p className="text-[11.5px] text-[var(--text-muted)]">
            Browser 截图与录像参考默认独立关停；开启 `mediaArtifactsEnabled` 后仅显示经 magic-header 校验的白名单元数据（不含 SVG/HTML）。
          </p>
        ) : observation.mediaReferences.length === 0 ? (
          <p className="text-[11.5px] text-[var(--text-muted)]">暂无已校验的截图或录像参考文件。</p>
        ) : (
          <ul className="space-y-1.5">
            {observation.mediaReferences.map((media) => (
              <li
                key={media.mediaId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-2 text-[11px]"
              >
                <span className="font-mono-code text-[var(--text-primary)]">{media.label}</span>
                <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                  {media.mimeType} · {media.sizeBytes}B ·{' '}
                  {media.magicVerified ? 'magic-verified' : 'header-unverified'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
