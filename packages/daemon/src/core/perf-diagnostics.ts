export interface PerfTraceSample {
  id: string;
  sessionId?: string;
  contract?: string;
  runtimeReceivedAt?: number;
  coalescerEnqueuedAt?: number;
  coalescerFlushedAt?: number;
  postCommitAt?: number;
  wsEnqueuedAt?: number;
  wsFlushedAt?: number;
  batchSize: number;
  queueDepth: number;
  backlogMs: number;
}

export interface PerfQueueMetrics {
  currentDepth: number;
  highWaterMark: number;
  maxBacklogMs: number;
  totalBatches: number;
  totalItems: number;
  maxBatchSize: number;
  recentBatchSizes: number[];
}

export interface PerfDiagnosticsSnapshot {
  enabled: boolean;
  serverNowMs: number;
  hrtimeMs: number;
  activeSubscriptions: {
    wsService: number;
    wsSession: number;
    wsCommandOutput: number;
    wsTerminal: number;
  };
  activeTimers: {
    wsServiceFlush: number;
    deltaCoalescer: number;
  };
  queues: {
    wsService: Omit<PerfQueueMetrics, 'recentBatchSizes'> & { batchSizeP95: number; batchSizeAvg: number };
    runtimeCommit: Omit<PerfQueueMetrics, 'recentBatchSizes'> & { batchSizeP95: number; batchSizeAvg: number };
    deltaCoalescer: Omit<PerfQueueMetrics, 'recentBatchSizes'> & { batchSizeP95: number; batchSizeAvg: number };
  };
  recentTraces: PerfTraceSample[];
  notes: string[];
}

function makeQueueMetrics(): PerfQueueMetrics {
  return {
    currentDepth: 0,
    highWaterMark: 0,
    maxBacklogMs: 0,
    totalBatches: 0,
    totalItems: 0,
    maxBatchSize: 0,
    recentBatchSizes: [],
  };
}

function summarizeQueue(q: PerfQueueMetrics) {
  const sorted = q.recentBatchSizes.slice().sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]! : 0;
  const avg = q.totalBatches > 0 ? Number((q.totalItems / q.totalBatches).toFixed(2)) : 0;
  return {
    currentDepth: q.currentDepth,
    highWaterMark: q.highWaterMark,
    maxBacklogMs: q.maxBacklogMs,
    totalBatches: q.totalBatches,
    totalItems: q.totalItems,
    maxBatchSize: q.maxBatchSize,
    batchSizeP95: p95,
    batchSizeAvg: avg,
  };
}

const MAX_RECENT_TRACES = 2000;
const MAX_BATCH_SAMPLES = 512;

export class PerfDiagnosticsCollector {
  private enabled = process.env.HARNESSMATE_PERF_DIAG === '1';
  private wsServiceSubscriptions = 0;
  private wsSessionSubscriptions = 0;
  private wsCommandOutputSubscriptions = 0;
  private wsTerminalSubscriptions = 0;
  private wsServiceFlushTimers = 0;
  private deltaCoalescerTimers = 0;

  private wsServiceQueue = makeQueueMetrics();
  private runtimeCommitQueue = makeQueueMetrics();
  private deltaCoalescerQueue = makeQueueMetrics();
  private recentTraces: PerfTraceSample[] = [];
  private traceSeq = 0;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean, reset = false): void {
    this.enabled = enabled;
    if (reset) this.reset();
  }

  reset(): void {
    this.wsServiceQueue.highWaterMark = this.wsServiceQueue.currentDepth;
    this.wsServiceQueue.maxBacklogMs = 0;
    this.wsServiceQueue.totalBatches = 0;
    this.wsServiceQueue.totalItems = 0;
    this.wsServiceQueue.maxBatchSize = 0;
    this.wsServiceQueue.recentBatchSizes = [];

    this.runtimeCommitQueue.highWaterMark = this.runtimeCommitQueue.currentDepth;
    this.runtimeCommitQueue.maxBacklogMs = 0;
    this.runtimeCommitQueue.totalBatches = 0;
    this.runtimeCommitQueue.totalItems = 0;
    this.runtimeCommitQueue.maxBatchSize = 0;
    this.runtimeCommitQueue.recentBatchSizes = [];

    this.deltaCoalescerQueue.highWaterMark = this.deltaCoalescerQueue.currentDepth;
    this.deltaCoalescerQueue.maxBacklogMs = 0;
    this.deltaCoalescerQueue.totalBatches = 0;
    this.deltaCoalescerQueue.totalItems = 0;
    this.deltaCoalescerQueue.maxBatchSize = 0;
    this.deltaCoalescerQueue.recentBatchSizes = [];

    this.recentTraces = [];
  }

  adjustSubscription(kind: 'wsService' | 'wsSession' | 'wsCommandOutput' | 'wsTerminal', delta: number): void {
    if (kind === 'wsService') this.wsServiceSubscriptions = Math.max(0, this.wsServiceSubscriptions + delta);
    else if (kind === 'wsSession') this.wsSessionSubscriptions = Math.max(0, this.wsSessionSubscriptions + delta);
    else if (kind === 'wsCommandOutput') this.wsCommandOutputSubscriptions = Math.max(0, this.wsCommandOutputSubscriptions + delta);
    else this.wsTerminalSubscriptions = Math.max(0, this.wsTerminalSubscriptions + delta);
  }

  adjustTimer(kind: 'wsServiceFlush' | 'deltaCoalescer', delta: number): void {
    if (kind === 'wsServiceFlush') this.wsServiceFlushTimers = Math.max(0, this.wsServiceFlushTimers + delta);
    else this.deltaCoalescerTimers = Math.max(0, this.deltaCoalescerTimers + delta);
  }

  setQueueDepth(kind: 'wsService' | 'runtimeCommit' | 'deltaCoalescer', depth: number): void {
    const q = this.getQueue(kind);
    q.currentDepth = Math.max(0, depth);
    if (q.currentDepth > q.highWaterMark) q.highWaterMark = q.currentDepth;
  }

  adjustQueueDepth(kind: 'wsService' | 'runtimeCommit' | 'deltaCoalescer', delta: number): number {
    const q = this.getQueue(kind);
    q.currentDepth = Math.max(0, q.currentDepth + delta);
    if (q.currentDepth > q.highWaterMark) q.highWaterMark = q.currentDepth;
    return q.currentDepth;
  }

  recordBatchFlush(
    kind: 'wsService' | 'runtimeCommit' | 'deltaCoalescer',
    params: {
      batchSize: number;
      backlogMs: number;
      queueDepthAfter?: number;
      trace?: Omit<PerfTraceSample, 'id' | 'batchSize' | 'queueDepth' | 'backlogMs'>;
    },
  ): void {
    const q = this.getQueue(kind);
    const size = Math.max(0, params.batchSize);
    const backlog = Math.max(0, params.backlogMs);
    q.totalBatches += 1;
    q.totalItems += size;
    if (size > q.maxBatchSize) q.maxBatchSize = size;
    if (backlog > q.maxBacklogMs) q.maxBacklogMs = backlog;
    if (q.recentBatchSizes.length >= MAX_BATCH_SAMPLES) {
      q.recentBatchSizes.shift();
    }
    q.recentBatchSizes.push(size);
    if (params.queueDepthAfter !== undefined) {
      q.currentDepth = Math.max(0, params.queueDepthAfter);
    }

    if (this.enabled && params.trace) {
      if (this.recentTraces.length >= MAX_RECENT_TRACES) {
        this.recentTraces.shift();
      }
      this.recentTraces.push({
        id: `${kind}-${++this.traceSeq}`,
        ...params.trace,
        batchSize: size,
        queueDepth: q.currentDepth,
        backlogMs: backlog,
      });
    }
  }

  snapshot(includeTraces = this.enabled): PerfDiagnosticsSnapshot {
    return {
      enabled: this.enabled,
      serverNowMs: Date.now(),
      hrtimeMs: Number((process.hrtime.bigint() / 1_000_000n).toString()),
      activeSubscriptions: {
        wsService: this.wsServiceSubscriptions,
        wsSession: this.wsSessionSubscriptions,
        wsCommandOutput: this.wsCommandOutputSubscriptions,
        wsTerminal: this.wsTerminalSubscriptions,
      },
      activeTimers: {
        wsServiceFlush: this.wsServiceFlushTimers,
        deltaCoalescer: this.deltaCoalescerTimers,
      },
      queues: {
        wsService: summarizeQueue(this.wsServiceQueue),
        runtimeCommit: summarizeQueue(this.runtimeCommitQueue),
        deltaCoalescer: summarizeQueue(this.deltaCoalescerQueue),
      },
      recentTraces: includeTraces ? this.recentTraces.slice() : [],
      notes: [
        'postCommitAt is captured after SQLite IMMEDIATE transaction returns, distinct from event createdAt.',
        'Detailed trace ring buffer is captured in-memory on demand without per-token disk logging.',
      ],
    };
  }

  private getQueue(kind: 'wsService' | 'runtimeCommit' | 'deltaCoalescer'): PerfQueueMetrics {
    if (kind === 'wsService') return this.wsServiceQueue;
    if (kind === 'runtimeCommit') return this.runtimeCommitQueue;
    return this.deltaCoalescerQueue;
  }
}

export const perfDiagnostics = new PerfDiagnosticsCollector();
