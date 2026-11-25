import { ExternalLink, Layers } from 'lucide-react';
import { EntityStatusBadge } from '../shared';

/**
 * Evidence closure card for App-only Automations (`AGY-W12`) and Sidecars (`AGY-E08`).
 * Explicitly prevents emulating App Automations/Sidecars over ACP or building an HM scheduler.
 */
export function AppAutomationsClosureCard() {
  return (
    <section
      data-testid="np12-app-automations-closure"
      aria-label="App Automations 与 Sidecars 原生边界"
      className="space-y-2 rounded-2xl border p-3 text-[11.5px]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-hairline)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Layers size={13} className="text-[var(--accent-clay)]" aria-hidden="true" />
          <span className="font-semibold text-[var(--text-primary)]">
            App Automations &amp; Sidecars（仅限官方 App · 只读收口）
          </span>
          <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
            AGY-W12 · AGY-E08
          </span>
        </div>
        <EntityStatusBadge kind="gate" gate="unsupported" compact />
      </div>

      <p className="leading-relaxed text-[var(--text-secondary)]">
        跨会话持久计划（<span className="font-mono-code">/automation</span>）与 App 自管进程（Sidecars /{' '}
        <span className="font-mono-code">agentapi</span>）属于官方 Antigravity App 生命周期能力。
        HarnessMate <strong>不</strong>将其仿成 ACP，<strong>不</strong>建立 HM 自有调度器，也<strong>不</strong>重绑用户现有任务。
      </p>

      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        <a
          href="https://antigravity.google/docs/commands/automation/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[var(--accent-indigo)] hover:underline"
        >
          <span>官方 Automations 文档</span>
          <ExternalLink size={10.5} aria-hidden="true" />
        </a>
        <a
          href="https://antigravity.google/docs/sidecars/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[var(--accent-indigo)] hover:underline"
        >
          <span>官方 Sidecars 文档</span>
          <ExternalLink size={10.5} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
