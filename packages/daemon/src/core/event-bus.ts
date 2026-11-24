import type { AttentionItem, CanonicalEvent } from '@harnessmate/protocol';

type SessionListener = (event: CanonicalEvent) => void;
type AttentionListener = (item: AttentionItem) => void;

export class DaemonEventBus {
  private readonly sessionListeners = new Map<string, Set<SessionListener>>();
  private readonly attentionListeners = new Set<AttentionListener>();
  private readonly eventListeners = new Set<SessionListener>();

  subscribeEvents(listener: SessionListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeSession(sessionId: string, listener: SessionListener): () => void {
    let set = this.sessionListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.sessionListeners.delete(sessionId);
      }
    };
  }

  subscribeAttention(listener: AttentionListener): () => void {
    this.attentionListeners.add(listener);
    return () => {
      this.attentionListeners.delete(listener);
    };
  }

  publishEvent(event: CanonicalEvent): void {
    const set = this.sessionListeners.get(event.sessionId);
    const dispatch = (listener: SessionListener) => {
      try {
        listener(event);
      } catch {
        // isolate subscriber failures
      }
    };
    this.eventListeners.forEach(dispatch);
    set?.forEach(dispatch);
  }

  publishAttention(item: AttentionItem): void {
    for (const listener of this.attentionListeners) {
      try {
        listener(item);
      } catch {
        // isolate subscriber failures
      }
    }
  }
}
