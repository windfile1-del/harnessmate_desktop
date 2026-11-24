import type { Session } from '@harnessmate/protocol';
import { isImeComposing } from './ime';
import { nextAttentionSession, type TriageStateBySession } from './triage';

export function handleTriageShortcut(event: KeyboardEvent, composing: boolean, context: {
  modal: string | null;
  sessions: Session[];
  triage: TriageStateBySession;
  selectedSessionId: string | null;
  openPalette: (query?: string) => void;
  closePalette: () => void;
  selectSession: (session: Session) => void;
}): void {
  if (event.defaultPrevented || isImeComposing(event, composing)) return;
  const control = (event.ctrlKey || event.metaKey) && !event.altKey;
  const key = event.key.toLowerCase();
  if (control && !event.shiftKey && key === 'k') {
    event.preventDefault();
    if (event.repeat) return;
    if (context.modal === 'command_palette') context.closePalette();
    else context.openPalette();
  } else if (control && event.shiftKey && key === 'h' && context.selectedSessionId) {
    event.preventDefault();
    if (!event.repeat) context.openPalette('switch ');
  } else if (!context.modal && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
    (key === 'arrowdown' || key === 'arrowup')) {
    const next = nextAttentionSession(context.sessions, context.triage, context.selectedSessionId, key === 'arrowdown' ? 1 : -1);
    if (!next) return;
    event.preventDefault();
    if (next.id !== context.selectedSessionId) context.selectSession(next);
  }
}
