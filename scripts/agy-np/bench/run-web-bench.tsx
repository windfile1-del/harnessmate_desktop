/**
 * NP-16 Reproducible T18 Web / UI Benchmark Entry
 *
 * Bundled onto D-drive temp directory via Vite's local esbuild and executed under pure Node
 * to avoid Vite/tsx loader skew. Measures:
 * - Disabled (`agyNativeWorkbenchEnabled: false`) baseline projection pass (`projectSessionEvents`)
 * - Enabled 10,000 events `applyNativeEventBatch` throughput + p50/p95 batch latencies
 * - Virtualization `computeVirtualWindow` + `renderToStaticMarkup(<NativeTimeline />)` across 10,000 items
 * - 100 agents `SubagentManagerView` & 20 concurrent requests `NativeRequestQueuePanel` static render latencies
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '../../../packages/protocol/src/index';
import {
  NativeTimeline,
  computeVirtualWindow,
  createStressFixture,
  DEFAULT_WORKBENCH_ROUTE,
  makeFixtureCapabilities,
} from '../../../packages/web/src/components/agy/native/shared';
import { SubagentManagerView } from '../../../packages/web/src/components/agy/native/child/SubagentManagerView';
import { NativeRequestQueuePanel } from '../../../packages/web/src/components/agy/native/requests/NativeRequestQueuePanel';
import { applyNativeEventBatch } from '../../../packages/web/src/lib/native-client';
import { projectSessionEvents } from '../../../packages/web/src/lib/projector';

function summarize(samplesMs: number[]) {
  if (samplesMs.length === 0) return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, totalMs: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pick = (q: number) => Number(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!.toFixed(4));
  return {
    count: sorted.length,
    meanMs: Number((sum / sorted.length).toFixed(4)),
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    maxMs: Number(sorted[sorted.length - 1]!.toFixed(4)),
    totalMs: Number(sum.toFixed(2)),
  };
}

const sampleSession: Session = {
  id: 'sess_agy_stress',
  workspaceId: 'ws_stress',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy'],
  contextSyncMode: 'auto',
  cwd: 'D:/AppDataCache/np16-bench/ws',
  title: 'NP-16 T18 Web Stress Session',
  status: 'idle',
  model: 'gemini-3.8-flash',
  actualModel: 'gemini-3.8-flash',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 0,
  usage: null,
  pendingApprovalCount: 20,
  createdAt: 1_764_000_000_000,
  updatedAt: 1_764_000_000_000,
};

export function runWebBench(samples = 5) {
  const stress = createStressFixture({
    sessionId: 'sess_agy_stress',
    agentCount: 100,
    eventCount: 10_000,
    pendingRequestCount: 20,
  });
  const capabilities = makeFixtureCapabilities();

  // 1. Disabled baseline: projectSessionEvents (500 legacy canonical events, isolateAgyNativePlaceholders=false vs true)
  const legacyEvents = Array.from({ length: 500 }, (_, i) => ({
    sessionId: 'sess_agy_stress',
    seq: i + 1,
    turnId: `turn_${Math.floor(i / 5)}`,
    type: i % 5 === 0 ? ('turn.started' as const) : ('message.delta' as const),
    payload: i % 5 === 0 ? { userText: 'hi' } : { delta: 'tok ' },
    createdAt: 1_764_000_000_000 + i,
  }));
  const disabledProjMs: number[] = [];
  for (let s = 0; s < samples; s += 1) {
    const t0 = performance.now();
    projectSessionEvents(legacyEvents, { isolateAgyNativePlaceholders: false });
    disabledProjMs.push(performance.now() - t0);
  }

  // 2. Enabled: applyNativeEventBatch 10,000 events across 200-event micro-batches (50 batches = 10k)
  const batchLatencies: number[] = [];
  const sampleTotalBatchMs: number[] = [];
  let lastProj = stress.projection;
  for (let s = 0; s < samples; s += 1) {
    let cur = stress.projection;
    const ts0 = performance.now();
    for (let offset = 0; offset < stress.events.length; offset += 200) {
      const chunk = stress.events.slice(offset, offset + 200);
      const tb0 = performance.now();
      cur = applyNativeEventBatch(cur, chunk).projection;
      if (s === 0) batchLatencies.push(performance.now() - tb0);
    }
    sampleTotalBatchMs.push(performance.now() - ts0);
    lastProj = cur;
  }

  // 3. Virtualized NativeTimeline (10,000 entries -> only viewport + overscan rows rendered)
  const win = computeVirtualWindow(stress.timelineEntries.length, 24_000, 360, 76, 6);
  const timelineRenderMs: number[] = [];
  let timelineHtmlBytes = 0;
  for (let s = 0; s < samples; s += 1) {
    const t0 = performance.now();
    const html = renderToStaticMarkup(
      React.createElement(NativeTimeline, {
        entries: stress.timelineEntries,
        scopeLabel: 'T18 Stress Timeline (10k)',
        rowHeightPx: 76,
        viewportHeightPx: 360,
        overscan: 6,
      }),
    );
    timelineRenderMs.push(performance.now() - t0);
    if (s === 0) timelineHtmlBytes = Buffer.byteLength(html, 'utf8');
  }

  // 4. 100-agent SubagentManagerView render
  const subagentRenderMs: number[] = [];
  let subagentHtmlBytes = 0;
  const noop = async () => {};
  const noopLoad = async () => ({
    schemaVersion: 1 as const,
    scopeKind: 'agent' as const,
    scopeId: 'ag_stress_child_1',
    revision: 1,
    items: [],
    nextPageToken: null,
    hasMore: false,
  });
  for (let s = 0; s < samples; s += 1) {
    const t0 = performance.now();
    const html = renderToStaticMarkup(
      React.createElement(SubagentManagerView, {
        session: sampleSession,
        projection: lastProj,
        syncState: {
          phase: 'live',
          resyncCount: 0,
          droppedStaleEvents: 0,
          lastSyncedAt: Date.now(),
          lastError: null,
          incompleteReason: null,
        },
        capabilities,
        pendingApprovals: stress.approvals,
        route: DEFAULT_WORKBENCH_ROUTE,
        onNavigate: () => {},
        onRefresh: () => {},
        onBackToChat: () => {},
        onSubmitCommand: async () => true,
        onDispatchControl: noop,
        onResolveRequest: noop,
        loadTimeline: noopLoad,
      }),
    );
    subagentRenderMs.push(performance.now() - t0);
    if (s === 0) subagentHtmlBytes = Buffer.byteLength(html, 'utf8');
  }

  // 5. 20 concurrent pending requests NativeRequestQueuePanel render
  const reqPanelRenderMs: number[] = [];
  let reqHtmlBytes = 0;
  for (let s = 0; s < samples; s += 1) {
    const t0 = performance.now();
    const html = renderToStaticMarkup(
      React.createElement(NativeRequestQueuePanel, {
        title: 'T18 Pending Requests (20)',
        projection: lastProj,
        approvals: stress.approvals,
      }),
    );
    reqPanelRenderMs.push(performance.now() - t0);
    if (s === 0) reqHtmlBytes = Buffer.byteLength(html, 'utf8');
  }

  const mem = process.memoryUsage();
  return {
    suite: 'np16-t18-web-bench',
    samples,
    disabledLegacyProjectorLatency: summarize(disabledProjMs),
    enabledEventBatching: {
      totalEvents: stress.events.length,
      batchSize: 200,
      asOfSeqAfter: lastProj.asOfSeq,
      workCountAfter: lastProj.work.length,
      perBatch200Latency: summarize(batchLatencies),
      full10kReduceLatency: summarize(sampleTotalBatchMs),
    },
    virtualizedTimeline: {
      totalEntries: stress.timelineEntries.length,
      renderedWindowMidScroll: win.renderedCount,
      htmlBytesInitialViewport: timelineHtmlBytes,
      renderLatency: summarize(timelineRenderMs),
    },
    subagent100Render: {
      totalAgents: lastProj.agents.length,
      htmlBytes: subagentHtmlBytes,
      renderLatency: summarize(subagentRenderMs),
    },
    requests20Render: {
      pendingApprovals: stress.approvals.length,
      htmlBytes: reqHtmlBytes,
      renderLatency: summarize(reqPanelRenderMs),
    },
    rssAfterMiB: Number((mem.rss / (1024 * 1024)).toFixed(2)),
    heapUsedAfterMiB: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
  };
}

const n = Number(process.env.HM_WEB_BENCH_SAMPLES || '5') || 5;
console.log(JSON.stringify(runWebBench(n), null, 2));
