import {
  Clock,
  Cpu,
  Hourglass,
  RefreshCw,
  ShieldAlert,
  WifiOff,
} from 'lucide-react';
import { EntityStatusBadge, toneStyle } from '../shared';
import type { NativeRuntimeStatus } from '../../../../lib/native-client';
import type { RuntimeBannerModel } from './runtime-view-model';

export interface RuntimeStatusBannerProps {
  readonly runtimeStatus: NativeRuntimeStatus;
  readonly banner: RuntimeBannerModel;
  readonly onRefresh: () => void;
}

function BannerIcon({ phase }: { phase: RuntimeBannerModel['phase'] }) {
  switch (phase) {
    case 'reconnecting':
      return <RefreshCw size={14} className="shrink-0 animate-spin" aria-hidden="true" />;
    case 'disconnected':
      return <WifiOff size={14} className="shrink-0" aria-hidden="true" />;
    case 'requires_action':
      return <ShieldAlert size={14} className="shrink-0" aria-hidden="true" />;
    case 'waiting_background':
      return <Hourglass size={14} className="shrink-0" aria-hidden="true" />;
    case 'cancelling':
      return <Clock size={14} className="shrink-0" aria-hidden="true" />;
    default:
      return <Cpu size={14} className="shrink-0" aria-hidden="true" />;
  }
}

function formatLeaseTag(reason: string): { label: string; isDaemon: boolean } {
  if (reason.startsWith('finite_work:')) {
    return { label: `有限保活 · ${reason.slice('finite_work:'.length)}`, isDaemon: false };
  }
  if (reason.startsWith('daemon_observe:')) {
    return { label: `Daemon 观察 · ${reason.slice('daemon_observe:'.length)}`, isDaemon: true };
  }
  if (reason.startsWith('pending_request:')) {
    return { label: `待处理请求 · ${reason.slice('pending_request:'.length)}`, isDaemon: false };
  }
  if (reason.startsWith('cancel_grace:')) {
    return { label: `取消宽限 · ${reason.slice('cancel_grace:'.length)}`, isDaemon: false };
  }
  if (reason.startsWith('held_turn:')) {
    return { label: `轮次持有 · ${reason.slice('held_turn:'.length)}`, isDaemon: false };
  }
  return { label: reason, isDaemon: false };
}

/**
 * Top Native Runtime status banner surfacing:
 * - Waiting for finite background work (`waiting_background`)
 * - Requires user action (`requires_action`)
 * - Reconnecting / reconciling / disconnected (`reconnecting` / `disconnected`)
 * - Separate finite-blocking vs detached-daemon counts & retention lease pills
 */
export function RuntimeStatusBanner({
  runtimeStatus,
  banner,
  onRefresh,
}: RuntimeStatusBannerProps) {
  const style = toneStyle(banner.tone);

  return (
    <section
      data-testid="np04-runtime-status-banner"
      data-runtime-phase={banner.phase}
      aria-label="Native Runtime 顶部运行态摘要"
      className="space-y-2.5 rounded-2xl border p-3"
      style={{
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5" style={{ color: style.color }}>
            <BannerIcon phase={banner.phase} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="text-[12.5px] font-semibold"
                style={{ color: style.color }}
              >
                {banner.headline}
              </span>
              <EntityStatusBadge kind="runtime" status={runtimeStatus} compact />
            </div>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">
              {banner.detail}
            </p>
          </div>
        </div>

        {banner.showReconnectAction && (
          <button
            type="button"
            onClick={onRefresh}
            data-testid="np04-banner-reconnect-btn"
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <RefreshCw size={11.5} aria-hidden="true" />
            <span>重新连接 / 刷新快照</span>
          </button>
        )}
      </div>

      {/* Independent Finite-Blocking vs Detached-Daemon & User-Action Counters */}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <StatChip
          testId="np04-stat-finite"
          label="有限阻塞任务"
          value={banner.blockingFiniteCount}
          hint="阻塞轮次结算"
          accent="var(--accent-star)"
        />
        <StatChip
          testId="np04-stat-daemon"
          label="常驻 Daemon"
          value={banner.detachedDaemonCount}
          hint="独立不阻塞"
          accent="var(--accent-indigo)"
        />
        <StatChip
          testId="np04-stat-requests"
          label="需要用户操作"
          value={banner.pendingRequestCount}
          hint="权限 / 问答"
          accent="var(--accent-rose)"
        />
        <StatChip
          testId="np04-stat-unknown"
          label="未确认 / 未知"
          value={banner.unknownWorkCount}
          hint="不推断成功"
          accent="var(--text-secondary)"
        />
      </div>

      {banner.leaseReasons.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1 pt-0.5"
          data-testid="np04-lease-reasons"
          aria-label="进程保活原因"
        >
          <span className="text-[10.5px] text-[var(--text-muted)]">保活原因：</span>
          {banner.leaseReasons.map((reason) => {
            const formatted = formatLeaseTag(reason);
            return (
              <span
                key={reason}
                className="rounded-md border px-1.5 py-0.5 font-mono-code text-[10px]"
                style={{
                  backgroundColor: formatted.isDaemon
                    ? 'var(--accent-indigo-soft)'
                    : 'var(--bg-surface)',
                  borderColor: 'var(--border-hairline)',
                  color: formatted.isDaemon ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                }}
              >
                {formatted.label}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

function StatChip({
  testId,
  label,
  value,
  hint,
  accent,
}: {
  testId: string;
  label: string;
  value: number;
  hint: string;
  accent: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5"
    >
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[10.5px] text-[var(--text-muted)]">{label}</span>
        <span className="font-mono-code text-[13px] font-semibold" style={{ color: accent }}>
          {value}
        </span>
      </div>
      <div className="text-[9.5px] text-[var(--text-muted)]">{hint}</div>
    </div>
  );
}
