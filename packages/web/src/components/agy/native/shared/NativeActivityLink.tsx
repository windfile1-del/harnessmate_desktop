import { Activity as ActivityIcon, ArrowUpRight, ShieldAlert } from 'lucide-react';
import type { Activity, NativeWork } from '../../../../lib/native-client';
import { EntityStatusBadge } from './EntityStatusBadge';
import { ACTIVITY_ORIGIN_LABELS, WORK_KIND_LABELS } from './status-dictionary';

export interface NativeActivityLinkProps {
  activity: Activity;
  relatedWork?: NativeWork | null;
  pendingCount?: number;
  onOpenWorkbench: (activity: Activity) => void;
}

/**
 * Compact chat-timeline anchor card linking a user turn, native continuation,
 * or detached background task directly into its scoped Workbench view.
 */
export function NativeActivityLink({
  activity,
  relatedWork,
  pendingCount = 0,
  onOpenWorkbench,
}: NativeActivityLinkProps) {
  const isNativeContinuation = activity.origin !== 'user_turn';

  return (
    <div
      data-testid="native-activity-link"
      data-activity-origin={activity.origin}
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-[11.5px]"
      style={{
        backgroundColor: isNativeContinuation ? 'var(--accent-indigo-soft)' : 'var(--bg-surface)',
        border: `1px solid ${
          pendingCount > 0
            ? 'color-mix(in srgb, var(--accent-star) 45%, transparent)'
            : isNativeContinuation
              ? 'color-mix(in srgb, var(--accent-indigo) 32%, transparent)'
              : 'var(--border-hairline)'
        }`,
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ActivityIcon size={12.5} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
        <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-primary)]">
          {ACTIVITY_ORIGIN_LABELS[activity.origin]}
        </span>
        <EntityStatusBadge kind="activity" status={activity.state} compact />
        {relatedWork && (
          <>
            <span className="text-[11px] text-[var(--text-secondary)]">
              {WORK_KIND_LABELS[relatedWork.kind]}
            </span>
            <EntityStatusBadge kind="blocking" blocking={relatedWork.blocking} compact />
          </>
        )}
        {activity.summary && (
          <span className="max-w-[260px] truncate text-[var(--text-secondary)]">{activity.summary}</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {pendingCount > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
            style={{
              backgroundColor: 'var(--accent-star-soft)',
              color: 'var(--accent-star)',
            }}
          >
            <ShieldAlert size={10.5} aria-hidden="true" />
            <span>{pendingCount} 待处理</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpenWorkbench(activity)}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
        >
          <span>在工作台查看</span>
          <ArrowUpRight size={11.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
