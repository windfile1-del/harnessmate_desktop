import type { Session, UpdateSessionTriageRequest } from '@harnessmate/protocol';
import { AlarmClock, Check, Circle, Pin } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { isImeComposing } from '../lib/ime';
import { classifyTriage, type TriageFilter } from '../lib/triage';
import { useAppStore } from '../stores/app-store';
import { useBoundSessionPlugin } from '../slots/BoundSessionSurface';

export function openTriageSession(session: Session): Promise<void> {
  const state = useAppStore.getState();
  if (state.selectedWorkspaceId && state.selectedWorkspaceId !== session.workspaceId) {
    state.setSelectedWorkspaceId(session.workspaceId);
  }
  state.setSearchQuery('');
  return state.selectSession(session.id);
}

function isWindowActive() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function TriageInboxLifecycle() {
  const connected = useAppStore((state) => state.connected);
  const id = useAppStore((state) => state.selectedSessionId);
  const latestTurnSeq = useAppStore((state) => id ? state.triageBySession[id]?.latestTurnSeq : undefined);
  const [active, setActive] = useState(isWindowActive);

  useEffect(() => {
    const controller = new AbortController();
    const { refreshTriage } = useAppStore.getState();
    const refresh = (check: boolean) => void refreshTriage(check, controller.signal).catch(() => {});
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResume = () => {
      setActive(isWindowActive());
      if (document.visibilityState !== 'visible') return;
      clearTimeout(wakeTimer);
      wakeTimer = setTimeout(() => refresh(true), 50);
    };
    const onBlur = () => setActive(false);
    window.addEventListener('focus', onResume);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onResume);
    refresh(isWindowActive());
    return () => {
      controller.abort();
      clearTimeout(wakeTimer);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [connected]);

  useEffect(() => {
    if (!active || !id || latestTurnSeq === undefined) return;
    const controller = new AbortController();
    const { markTriageViewed, triageBySession } = useAppStore.getState();
    const meta = triageBySession[id]?.meta;
    if (meta && (meta.forceUnread || latestTurnSeq > meta.lastViewedTurnSeq)) {
      void markTriageViewed(id, { throughTurnSeq: latestTurnSeq, observedUpdatedAt: meta.updatedAt }, controller.signal).catch(() => {});
    }
    return () => controller.abort();
  }, [active, id, latestTurnSeq, connected]);

  useEffect(() => () => { useAppStore.setState({ triageBySession: {} }); }, []);
  return null;
}

export function TriageFilters({ filter, pendingCount, onChange }: {
  filter: TriageFilter;
  pendingCount: number;
  onChange: (filter: TriageFilter) => void;
}) {
  const filters = [['all', '全部'], ['pending', `待处理 (${pendingCount})`], ['deferred', '已延后']] as const;
  return (
    <div role="group" aria-label="会话筛选" className="flex gap-1 rounded-xl bg-[var(--bg-surface)] p-1">
      {filters.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={filter === id} onClick={() => onChange(id)}
          className="flex-1 rounded-lg px-1 py-1 text-[11px] aria-pressed:bg-[var(--bg-active)] aria-pressed:text-[var(--text-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
          {label}
        </button>
      ))}
    </div>
  );
}

export function nextMorning(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9).getTime();
}

function SnoozeMenu({ anchor, trigger, isSnoozed, onClose, onChoose }: {
  anchor: DOMRect;
  trigger: RefObject<HTMLButtonElement | null>;
  isSnoozed: boolean;
  onClose: () => void;
  onChoose: (time: number | null) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState('');
  const time = Date.parse(custom);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, trigger]);

  return createPortal(
    <div ref={menu} role="dialog" aria-label="延后提醒"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && !isImeComposing(event, false)) onClose();
      }}
      className="fixed z-40 w-52 space-y-1 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] p-2 text-xs text-[var(--text-primary)] shadow-xl"
      style={{
        left: Math.max(8, Math.min(anchor.right - 208, window.innerWidth - 216)),
        ...(window.innerHeight - anchor.bottom >= 220 ? { top: anchor.bottom + 4 } : { bottom: window.innerHeight - anchor.top + 4 }),
      }}>
      <button type="button" autoFocus onClick={() => onChoose(Date.now() + 30 * 60_000)} className={menuButton}>30 分钟后</button>
      <button type="button" onClick={() => onChoose(Date.now() + 2 * 60 * 60_000)} className={menuButton}>2 小时后</button>
      <button type="button" onClick={() => onChoose(nextMorning())} className={menuButton}>明天上午 9:00</button>
      <input type="datetime-local" aria-label="自定义提醒时间" value={custom} onChange={(event) => setCustom(event.target.value)}
        className="w-full rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1 py-1" />
      <button type="button" disabled={!(time > Date.now())} onClick={() => onChoose(time)}
        className={`${menuButton} disabled:opacity-50`}>设置自定义提醒</button>
      {isSnoozed && <button type="button" onClick={() => onChoose(null)} className={menuButton}>取消延后</button>}
    </div>,
    document.body,
  );
}

const menuButton = 'block w-full rounded px-2 py-1.5 text-left hover:bg-[var(--bg-hover)]';
const actionButton = 'rounded p-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]';

export function TriageSidebarBadge({ session }: { session: Session }) {
  const state = useAppStore((store) => store.triageBySession[session.id]);
  const selected = useAppStore((store) => store.selectedSessionId === session.id);
  const enabled = useBoundSessionPlugin('session.inbox.v1', session);
  const snoozeEnabled = useBoundSessionPlugin('session.snooze.v1', session);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const snoozeButton = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => {
    setAnchor(null);
    snoozeButton.current?.focus();
  }, []);
  if (!enabled) return null;
  const group = classifyTriage(session, state);
  const meta = state?.meta;
  const apply = (patch: UpdateSessionTriageRequest) => {
    const { updateTriage, pushToast } = useAppStore.getState();
    void updateTriage(session.id, patch).catch(() => pushToast({ kind: 'warning', title: '更新会话待办失败，请重试' }));
  };
  const action = (event: MouseEvent, patch: UpdateSessionTriageRequest) => {
    event.stopPropagation();
    apply(patch);
  };
  const snoozedUntil = meta?.snoozedUntilMs;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {group === 'needs_attention' && !selected && <span title="需要处理" aria-label="需要处理" className="h-2 w-2 rounded-full bg-[var(--accent-rose)]" />}
      {group === 'unread' && <span title="未读结果" aria-label="未读结果" className="h-2 w-2 rounded-full bg-[var(--accent-indigo)]" />}
      {group === 'running' && <span title="运行中" aria-label="运行中" className="h-2 w-2 animate-pulse-halo rounded-full bg-[var(--accent-emerald)]" />}
      {snoozedUntil != null && <span title={`延后至 ${new Date(snoozedUntil).toLocaleString()}`}><AlarmClock size={12} /></span>}
      {meta?.pinned && <span title="已置顶"><Pin size={12} /></span>}
      {meta?.settled && <span title="已处理"><Check size={12} /></span>}
      <span className={`flex overflow-hidden ${anchor ? '' : 'max-w-0 group-hover:max-w-24 group-focus-within:max-w-24'}`}>
        <button type="button" className={actionButton} title={meta?.pinned ? '取消置顶' : '置顶'}
          aria-label={meta?.pinned ? '取消置顶' : '置顶'} onClick={(event) => action(event, { pinned: !meta?.pinned })}><Pin size={13} /></button>
        {snoozeEnabled && <button type="button" className={actionButton} ref={snoozeButton} title="延后提醒" aria-label="延后提醒"
          aria-expanded={!!anchor} onClick={(event) => {
            event.stopPropagation();
            setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect());
          }}><AlarmClock size={13} /></button>}
        <button type="button" className={actionButton} title={meta?.settled ? '重新待办' : '标为已处理'}
          aria-label={meta?.settled ? '重新待办' : '标为已处理'} onClick={(event) => action(event, { settled: !meta?.settled })}><Check size={13} /></button>
        <button type="button" className={actionButton} title="标为未读" aria-label="标为未读"
          onClick={(event) => action(event, { forceUnread: true })}><Circle size={13} /></button>
      </span>
      {anchor && snoozeEnabled && <SnoozeMenu anchor={anchor} trigger={snoozeButton} isSnoozed={snoozedUntil != null} onClose={closeMenu}
        onChoose={(snoozedUntilMs) => {
        closeMenu();
        apply({ snoozedUntilMs });
      }} />}
    </span>
  );
}
