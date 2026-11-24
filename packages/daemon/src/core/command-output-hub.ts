export interface CommandOutputChunk {
  sessionId: string;
  toolCallId: string;
  chunk: string;
  stream: 'stdout' | 'stderr';
  snapshot?: boolean;
  done?: boolean;
  timestamp: number;
}

type CommandOutputListener = (event: CommandOutputChunk) => void;

interface OutputChannel {
  key: string;
  sessionId: string;
  toolCallId: string;
  buffer: string;
  totalBytes: number;
  truncated: boolean;
  completed: boolean;
  updatedAt: number;
  listeners: Set<CommandOutputListener>;
}

export interface CommandOutputHubOptions {
  /** Max in-memory UTF-8 bytes retained per command stream ring buffer (default 256 KiB). */
  maxRingBytes?: number;
  /** Max completed channels retained for quick UI re-open before LRU eviction (default 64). */
  maxCompletedChannels?: number;
}

/**
 * Side-channel in-memory hub for high-frequency command/tool stdout/stderr deltas.
 * Prevents raw command output bursts from bloating SQLite `session_events`.
 */
export class CommandOutputHub {
  private readonly channels = new Map<string, OutputChannel>();
  private readonly maxRingBytes: number;
  private readonly maxCompletedChannels: number;

  constructor(opts: CommandOutputHubOptions = {}) {
    this.maxRingBytes = Math.max(4_096, opts.maxRingBytes ?? 256 * 1024);
    this.maxCompletedChannels = Math.max(8, opts.maxCompletedChannels ?? 64);
  }

  private channelKey(sessionId: string, toolCallId: string): string {
    return `${sessionId}::${toolCallId}`;
  }

  private getOrCreate(sessionId: string, toolCallId: string): OutputChannel {
    const key = this.channelKey(sessionId, toolCallId);
    let channel = this.channels.get(key);
    if (!channel) {
      channel = {
        key,
        sessionId,
        toolCallId,
        buffer: '',
        totalBytes: 0,
        truncated: false,
        completed: false,
        updatedAt: Date.now(),
        listeners: new Set(),
      };
      this.channels.set(key, channel);
    }
    return channel;
  }

  append(
    sessionId: string,
    toolCallId: string,
    chunk: string,
    stream: 'stdout' | 'stderr' = 'stdout',
  ): void {
    if (!chunk) return;
    const channel = this.getOrCreate(sessionId, toolCallId);
    const now = Date.now();
    channel.updatedAt = now;
    channel.totalBytes += Buffer.byteLength(chunk, 'utf8');

    const combined = channel.buffer + chunk;
    if (Buffer.byteLength(combined, 'utf8') > this.maxRingBytes) {
      // Keep the most recent tail within ring budget
      const tailBytes = Buffer.from(combined, 'utf8');
      channel.buffer = tailBytes.subarray(Math.max(0, tailBytes.length - this.maxRingBytes)).toString('utf8');
      channel.truncated = true;
    } else {
      channel.buffer = combined;
    }

    const frame: CommandOutputChunk = {
      sessionId,
      toolCallId,
      chunk,
      stream,
      timestamp: now,
    };
    for (const listener of channel.listeners) {
      try {
        listener(frame);
      } catch {
        // Isolate subscriber errors
      }
    }
  }

  complete(sessionId: string, toolCallId: string): void {
    const channel = this.channels.get(this.channelKey(sessionId, toolCallId));
    if (!channel) return;
    channel.completed = true;
    channel.updatedAt = Date.now();
    const frame: CommandOutputChunk = {
      sessionId,
      toolCallId,
      chunk: '',
      stream: 'stdout',
      done: true,
      timestamp: channel.updatedAt,
    };
    for (const listener of channel.listeners) {
      try {
        listener(frame);
      } catch {
        // ignore
      }
    }
    this.evictCompletedIfNeeded();
  }

  subscribe(sessionId: string, toolCallId: string, listener: CommandOutputListener): () => void {
    const channel = this.getOrCreate(sessionId, toolCallId);
    if (channel.buffer.length > 0 || channel.completed) {
      try {
        listener({
          sessionId,
          toolCallId,
          chunk: channel.buffer,
          stream: 'stdout',
          snapshot: true,
          done: channel.completed,
          timestamp: channel.updatedAt,
        });
      } catch {
        // ignore
      }
    }
    channel.listeners.add(listener);
    return () => {
      channel.listeners.delete(listener);
    };
  }

  getSnapshot(sessionId: string, toolCallId: string): {
    text: string;
    totalBytes: number;
    truncated: boolean;
    completed: boolean;
  } | null {
    const channel = this.channels.get(this.channelKey(sessionId, toolCallId));
    if (!channel) return null;
    return {
      text: channel.buffer,
      totalBytes: channel.totalBytes,
      truncated: channel.truncated,
      completed: channel.completed,
    };
  }

  clearSession(sessionId: string): void {
    for (const [key, ch] of this.channels.entries()) {
      if (ch.sessionId === sessionId) {
        ch.listeners.clear();
        this.channels.delete(key);
      }
    }
  }

  stats(): { activeChannels: number; completedChannels: number; totalBufferedBytes: number } {
    let activeChannels = 0;
    let completedChannels = 0;
    let totalBufferedBytes = 0;
    for (const ch of this.channels.values()) {
      if (ch.completed) completedChannels += 1;
      else activeChannels += 1;
      totalBufferedBytes += Buffer.byteLength(ch.buffer, 'utf8');
    }
    return { activeChannels, completedChannels, totalBufferedBytes };
  }

  private evictCompletedIfNeeded(): void {
    const completed = Array.from(this.channels.values())
      .filter((ch) => ch.completed && ch.listeners.size === 0)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (completed.length > this.maxCompletedChannels) {
      const oldest = completed.shift();
      if (oldest) this.channels.delete(oldest.key);
    }
  }
}
