export interface FrontendPerfBatchTrace {
  subscriptionId: string;
  hostWsReceivedAt: number;
  pluginReceivedAt?: number;
  serverFlushedAt?: number;
  runtimeReceivedAt?: number;
  postCommitAt?: number;
  eventCount: number;
  serverQueueDepth?: number;
  serverBacklogMs?: number;
  pluginQueueDepth?: number;
  pluginBacklogMs?: number;
}

export interface FrontendPerfStats {
  enabled: boolean;
  clockOffsetMs: number;
  clockRttMs: number;
  activePluginSubscriptions: number;
  activePluginTimers: number;
  pluginQueueDepth: number;
  pluginQueueHighWater: number;
  pluginMaxBacklogMs: number;
  pluginBatchCount: number;
  pluginMaxBatchSize: number;
  hostWsFrames: number;
  recentBatches: FrontendPerfBatchTrace[];
}

const MAX_FRONTEND_BATCHES = 2500;

class FrontendPerfDiagnostics {
  private enabled = typeof window !== 'undefined' && (
    window.location?.search?.includes('perfDiag=1') ||
    (window as unknown as { __HM_PERF_DIAG_ENABLED__?: boolean }).__HM_PERF_DIAG_ENABLED__ === true
  );
  private clockOffsetMs = 0;
  private clockRttMs = 0;
  private activePluginSubscriptions = 0;
  private activePluginTimers = 0;
  private pluginQueueDepth = 0;
  private pluginQueueHighWater = 0;
  private pluginMaxBacklogMs = 0;
  private pluginBatchCount = 0;
  private pluginMaxBatchSize = 0;
  private hostWsFrames = 0;
  private recentBatches: FrontendPerfBatchTrace[] = [];

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean, reset = false): void {
    this.enabled = enabled;
    if (reset) this.reset();
  }

  reset(): void {
    this.pluginQueueHighWater = this.pluginQueueDepth;
    this.pluginMaxBacklogMs = 0;
    this.pluginBatchCount = 0;
    this.pluginMaxBatchSize = 0;
    this.hostWsFrames = 0;
    this.recentBatches = [];
  }

  async calibrateClock(apiBase = ''): Promise<{ clockOffsetMs: number; clockRttMs: number }> {
    const t0 = Date.now();
    const res = await fetch(`${apiBase}/api/v1/diagnostics/perf`);
    const t1 = Date.now();
    if (res.ok) {
      const data = (await res.json()) as { serverNowMs?: number };
      if (typeof data.serverNowMs === 'number') {
        this.clockRttMs = Math.max(0, t1 - t0);
        const midpoint = t0 + this.clockRttMs / 2;
        // clockOffsetMs = clientClock - serverClock (subtract from client timestamps or add to server timestamps)
        this.clockOffsetMs = Math.round(midpoint - data.serverNowMs);
      }
    }
    return { clockOffsetMs: this.clockOffsetMs, clockRttMs: this.clockRttMs };
  }

  adjustPluginSubscription(delta: number): void {
    this.activePluginSubscriptions = Math.max(0, this.activePluginSubscriptions + delta);
  }

  adjustPluginTimer(delta: number): void {
    this.activePluginTimers = Math.max(0, this.activePluginTimers + delta);
  }

  recordPluginQueue(depth: number, backlogMs = 0, batchSize = 0): void {
    this.pluginQueueDepth = Math.max(0, depth);
    if (this.pluginQueueDepth > this.pluginQueueHighWater) {
      this.pluginQueueHighWater = this.pluginQueueDepth;
    }
    if (backlogMs > this.pluginMaxBacklogMs) this.pluginMaxBacklogMs = backlogMs;
    if (batchSize > 0) {
      this.pluginBatchCount += 1;
      if (batchSize > this.pluginMaxBatchSize) this.pluginMaxBatchSize = batchSize;
    }
  }

  recordHostWsBatch(entry: FrontendPerfBatchTrace): void {
    this.hostWsFrames += 1;
    if (!this.enabled) return;
    if (this.recentBatches.length >= MAX_FRONTEND_BATCHES) {
      this.recentBatches.shift();
    }
    this.recentBatches.push(entry);
  }

  snapshot(): FrontendPerfStats {
    return {
      enabled: this.enabled,
      clockOffsetMs: this.clockOffsetMs,
      clockRttMs: this.clockRttMs,
      activePluginSubscriptions: this.activePluginSubscriptions,
      activePluginTimers: this.activePluginTimers,
      pluginQueueDepth: this.pluginQueueDepth,
      pluginQueueHighWater: this.pluginQueueHighWater,
      pluginMaxBacklogMs: this.pluginMaxBacklogMs,
      pluginBatchCount: this.pluginBatchCount,
      pluginMaxBatchSize: this.pluginMaxBatchSize,
      hostWsFrames: this.hostWsFrames,
      recentBatches: this.enabled ? this.recentBatches.slice() : [],
    };
  }
}

export const frontendPerfDiagnostics: FrontendPerfDiagnostics = (() => {
  if (typeof window !== 'undefined') {
    const existing = (window as unknown as { __HM_PERF_DIAG__?: FrontendPerfDiagnostics }).__HM_PERF_DIAG__;
    if (existing) return existing;
    const created = new FrontendPerfDiagnostics();
    (window as unknown as { __HM_PERF_DIAG__?: FrontendPerfDiagnostics }).__HM_PERF_DIAG__ = created;
    return created;
  }
  return new FrontendPerfDiagnostics();
})();
