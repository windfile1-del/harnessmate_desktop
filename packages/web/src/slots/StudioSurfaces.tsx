import type { Session } from '@harnessmate/protocol';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { daemonApi } from '../api/client';
import type { TimelineMinimapEntry, TurnBlock, WorkGroupProjection, WorkStepBlock } from '../lib/work-groups';
import { useAppStore } from '../stores/app-store';
import { BoundSessionSurface, useBoundSessionPlugin } from './BoundSessionSurface';

const STUDIO = 'session.studio.v1';
type Plugin = ReturnType<typeof useBoundSessionPlugin>;
const StudioContext = createContext<Plugin>(undefined);

export function StudioScope({ session, children }: { session: Session; children: ReactNode }) {
  const plugin = useBoundSessionPlugin(STUDIO, session);
  return <StudioContext.Provider value={plugin}>{children}</StudioContext.Provider>;
}

function WorkStep({ session, block, plugin }: { session: Session; block: WorkStepBlock; plugin: Plugin }) {
  const [open, setOpen] = useState(block.status === 'failed');
  const callId = 'toolCallId' in block ? block.toolCallId : undefined;
  const canStream = block.type === 'command_execution' || (block.type === 'tool_call' && block.toolKind === 'shell');
  const live = useAppStore((state) => open && canStream && callId ? state.liveCommandOutputByKey[`${session.id}::${callId}`] : undefined);
  const subscribe = useAppStore((state) => state.subscribeCommandOutput);
  useEffect(() => {
    if (plugin && open && canStream && callId && !live?.done) return subscribe(session.id, callId);
  }, [plugin, open, canStream, session.id, callId, live?.done, subscribe]);
  const summary = block.type === 'command_execution' ? block.command
    : block.type === 'reasoning' ? '分析过程' : block.summary;
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} data-item-id={block.blockId}>
      <summary className="cursor-pointer break-words px-2 py-1 text-xs">{summary}</summary>
      {open && <BoundSessionSurface
        plugin={plugin}
        session={session}
        surface="studio-tool"
        props={{ block, liveOutput: live?.text, itemId: block.blockId, toolCallId: callId }}
        onAction={(action, params, signal) => {
          if (action === 'readOutput') {
            const textOffset = typeof params.offset === 'number' ? Math.max(0, Math.floor(params.offset)) : 0;
            return daemonApi.getSessionTurnItem(session.id, block.blockId, { textOffset, maxChars: 65_536 }, signal);
          }
          if (action === 'openFile' && typeof params.path === 'string' && block.type === 'file_change'
            && block.files.some(({ path }) => path === params.path)) {
            const line = typeof params.line === 'number' && Number.isSafeInteger(params.line) && params.line > 0
              ? params.line : undefined;
            useAppStore.getState().openInspectorFile(session.id, params.path, line);
            return { ok: true };
          }
          throw new Error('此条目不支持该操作');
        }}
      />}
    </details>
  );
}

export function StudioWorkGroup({ session, group }: { session: Session; group: WorkGroupProjection }) {
  const plugin = useContext(StudioContext);
  const [expanded, setExpanded] = useState<boolean | undefined>();
  const open = expanded ?? !group.collapsedByDefault;
  if (!plugin) return <p className="text-xs text-[var(--text-muted)]">{group.summaryText} · 工作详情不可用</p>;
  return (
    <section data-testid="work-group-row" className="rounded-xl border border-[var(--border-hairline)] p-2">
      <button type="button" aria-expanded={open} onClick={() => setExpanded(!open)}
        className="w-full cursor-pointer px-2 py-1 text-left text-xs">{group.summaryText}</button>
      {open && <>
        <BoundSessionSurface plugin={plugin} session={session} surface="studio-work-group"
          props={{ groupId: group.groupId, status: group.status, durationMs: group.durationMs, activeStep: group.activeStepTitle }} />
        {group.blocks.map((block) => <WorkStep key={block.blockId} session={session} block={block} plugin={plugin} />)}
      </>}
    </section>
  );
}

export function StudioExtension({ session, block }: { session: Session; block: TurnBlock }) {
  const plugin = useContext(StudioContext);
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!element.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { rootMargin: '240px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={element} data-item-id={block.blockId} className="min-h-8">
      {plugin && visible ? <BoundSessionSurface plugin={plugin} session={session} surface="studio-extension" props={{ block }} />
        : <span className="text-xs text-[var(--text-muted)]">{block.type}{!plugin && ' · 扩展视图不可用'}</span>}
    </div>
  );
}

export function StudioMinimap({ session, entries, activeTurnId }: {
  session: Session; entries: readonly TimelineMinimapEntry[]; activeTurnId?: string | null;
}) {
  const plugin = useContext(StudioContext);
  if (!plugin || entries.length < 3) return null;
  return (
    <aside className="hidden w-9 shrink-0 overflow-y-auto xl:block" aria-label="对话轮次小地图">
      <BoundSessionSurface plugin={plugin} session={session} surface="studio-timeline"
        props={{ entries, activeTurnId }} defaultHeight={160}
        onAction={(action, params) => {
          const turn = entries.find((item) => item.kind === 'turn' && item.id === params.turnId);
          if (action === 'jump' && turn) useAppStore.getState().focusTurn({ sessionId: session.id, turnId: turn.id });
        }} />
    </aside>
  );
}
