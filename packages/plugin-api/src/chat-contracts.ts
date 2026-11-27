import type { ServiceMethodResult } from './context.js';

export const CHAT_VIEW_CONTRACT = 'chat.view.v1';
export interface ChatViewState {
  text?: string;
  attachments?: Array<Record<string, unknown>>;
  terminalContexts?: Array<Record<string, unknown>>;
  scrollTop?: number;
  followBottom?: boolean;
  timeline?: { scrollTop: number; followBottom: boolean };
  traitsByScope?: Record<string, Record<string, string | number | boolean>>;
  revision?: number;
}
export type ChatViewOperation =
  | { type: 'setText'; text: string }
  | { type: 'clear' | 'clearTerminalContexts' }
  | { type: 'addAttachment'; attachment: Record<string, unknown> }
  | { type: 'addTerminalContext'; chip: Record<string, unknown> }
  | { type: 'removeAttachment' | 'removeTerminalContext'; id: string };

/** View state is stored by the selected chat instance; reading never sends a turn. */
export interface ChatViewServiceV1 {
  readViewState(req: { sessionId: string }): Promise<ServiceMethodResult<{ state: ChatViewState }>>;
  writeViewState(req: { sessionId: string; patch: ChatViewState; sourceId?: string }): Promise<ServiceMethodResult<{ state: ChatViewState }>>;
  editViewState(req: { sessionId: string; operation: ChatViewOperation; sourceId?: string }): Promise<ServiceMethodResult<{ state: ChatViewState }>>;
}
