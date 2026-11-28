import { perfDiagnostics } from './perf-diagnostics.js';

export type CoalescedDeltaChannel = 'assistant' | 'thinking';

export interface CoalescedDeltaBatch {
  sessionId: string;
  turnId: string;
  channel: CoalescedDeltaChannel;
  text: string;
  messageId: string | null;
  parentToolUseId: string | null;
  harnessId: string;
  actualModel: string | null;
  mergedCount: number;
  firstReceivedAt: number;
  lastReceivedAt: number;
}

interface PendingDeltaEntry {
  key: string;
  sessionId: string;
  turnId: string;
  channel: CoalescedDeltaChannel;
  chunks: string[];
  bufferedChars: number;
  messageId: string | null;
  parentToolUseId: string | null;
  harnessId: string;
  actualModel: string | null;
  firstReceivedAt: number;
  lastReceivedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface TextDeltaCoalescerOptions {
  /** Coalescing window in milliseconds (default 50ms, modeled on T3 Code ProviderTextDeltaCoalescer). */
  windowMs?: number;
  /** Flush immediately once buffered chars exceed this limit to keep streaming responsive (default 4096). */
  maxCharsBeforeFlush?: number;
  onFlush: (batch: CoalescedDeltaBatch) => void;
}

/**
 * Coalesces rapid token deltas (assistant text & thinking) over a short window
 * so SQLite persistence and WebSocket broadcasts receive compact batches while
 * preserving exact chronological ordering via synchronous flush-before-boundary.
 */
export class TextDeltaCoalescer {
  private readonly pending = new Map<string, PendingDeltaEntry>();
  private readonly windowMs: number;
  private readonly maxCharsBeforeFlush: number;
  private readonly onFlush: (batch: CoalescedDeltaBatch) => void;

  constructor(opts: TextDeltaCoalescerOptions) {
    this.windowMs = Math.max(0, opts.windowMs ?? 50);
    this.maxCharsBeforeFlush = Math.max(256, opts.maxCharsBeforeFlush ?? 4_096);
    this.onFlush = opts.onFlush;
  }

  private entryKey(
    sessionId: string,
    turnId: string,
    channel: CoalescedDeltaChannel,
    messageId?: string | null,
    parentToolUseId?: string | null,
  ): string {
    return `${sessionId}::${turnId}::${channel}::${messageId ?? ''}::${parentToolUseId ?? ''}`;
  }

  push(input: {
    sessionId: string;
    turnId: string;
    channel: CoalescedDeltaChannel;
    text: string;
    messageId?: string | null;
    parentToolUseId?: string | null;
    harnessId: string;
    actualModel?: string | null;
    receivedAt?: number;
  }): void {
    if (!input.text) return;
    const now = input.receivedAt ?? Date.now();
    const key = this.entryKey(
      input.sessionId,
      input.turnId,
      input.channel,
      input.messageId,
      input.parentToolUseId,
    );

    // Flush any different active channel for the same session first so assistant/thinking never interleave out of order
    for (const [otherKey, other] of this.pending.entries()) {
      if (other.sessionId === input.sessionId && otherKey !== key) {
        this.flushEntry(otherKey);
      }
    }

    let entry = this.pending.get(key);
    if (!entry) {
      entry = {
        key,
        sessionId: input.sessionId,
        turnId: input.turnId,
        channel: input.channel,
        chunks: [],
        bufferedChars: 0,
        messageId: input.messageId ?? null,
        parentToolUseId: input.parentToolUseId ?? null,
        harnessId: input.harnessId,
        actualModel: input.actualModel ?? null,
        firstReceivedAt: now,
        lastReceivedAt: now,
        timer: null,
      };
      this.pending.set(key, entry);
      perfDiagnostics.setQueueDepth('deltaCoalescer', this.pending.size);
    }

    entry.chunks.push(input.text);
    entry.bufferedChars += input.text.length;
    entry.lastReceivedAt = now;
    if (input.actualModel !== undefined) entry.actualModel = input.actualModel;

    if (this.windowMs === 0 || entry.bufferedChars >= this.maxCharsBeforeFlush) {
      this.flushEntry(key);
      return;
    }

    if (!entry.timer) {
      perfDiagnostics.adjustTimer('deltaCoalescer', 1);
      entry.timer = setTimeout(() => {
        this.flushEntry(key);
      }, this.windowMs);
      entry.timer.unref?.();
    }
  }

  flushSession(sessionId: string): void {
    for (const [key, entry] of Array.from(this.pending.entries())) {
      if (entry.sessionId === sessionId) {
        this.flushEntry(key);
      }
    }
  }

  flushTurn(sessionId: string, turnId: string): void {
    for (const [key, entry] of Array.from(this.pending.entries())) {
      if (entry.sessionId === sessionId && entry.turnId === turnId) {
        this.flushEntry(key);
      }
    }
  }

  flushAll(): void {
    for (const key of Array.from(this.pending.keys())) {
      this.flushEntry(key);
    }
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        perfDiagnostics.adjustTimer('deltaCoalescer', -1);
      }
    }
    this.pending.clear();
    perfDiagnostics.setQueueDepth('deltaCoalescer', 0);
  }

  private flushEntry(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
      perfDiagnostics.adjustTimer('deltaCoalescer', -1);
    }
    this.pending.delete(key);
    if (entry.chunks.length === 0) {
      perfDiagnostics.setQueueDepth('deltaCoalescer', this.pending.size);
      return;
    }
    const flushedAt = Date.now();
    perfDiagnostics.recordBatchFlush('deltaCoalescer', {
      batchSize: entry.chunks.length,
      backlogMs: flushedAt - entry.firstReceivedAt,
      queueDepthAfter: this.pending.size,
      trace: {
        sessionId: entry.sessionId,
        runtimeReceivedAt: entry.firstReceivedAt,
        coalescerEnqueuedAt: entry.firstReceivedAt,
        coalescerFlushedAt: flushedAt,
      },
    });

    this.onFlush({
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      channel: entry.channel,
      text: entry.chunks.join(''),
      messageId: entry.messageId,
      parentToolUseId: entry.parentToolUseId,
      harnessId: entry.harnessId,
      actualModel: entry.actualModel,
      mergedCount: entry.chunks.length,
      firstReceivedAt: entry.firstReceivedAt,
      lastReceivedAt: entry.lastReceivedAt,
    });
  }
}
