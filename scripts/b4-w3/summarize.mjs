// Summarizes reused historical B2/B3 raw runs alongside new B4 formal runs.
// Usage: node scripts/b4-w3/summarize.mjs <b2-b3-root> <b4-root> <output.json>
import fs from 'node:fs';
import path from 'node:path';

const b2b3Root = process.argv[2] || 'D:/HarnessMate/b3-tmp/w3/formal-performance';
const b4Root = process.argv[3] || 'D:/HarnessMate/b4-tmp/w3/formal-performance';
const output = process.argv[4] || 'docs/plugin-decoupling-batch-4/reports/evidence/performance-summary.json';

const quantile = (values, q) => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * q) - 1)] : null;
};

function markers(value) {
  return [...JSON.stringify(value).matchAll(/HMREPLAY_([0-9]+)_([0-9]+)/g)].map((m) => m[0]);
}

function canonical(frame) {
  if (!frame) return [];
  return frame.op === 'event'
    ? [frame.event]
    : (frame.events || []).flatMap((entry) => entry.payload?.events || []);
}

function first(map, key, value) {
  if (!Number.isFinite(value)) return;
  if (!map.has(key) || value < map.get(key)) map.set(key, value);
}

const runs = [];

function analyzeRun(version, run, file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const clockOffsetMs = Number(d.clockCalibration?.clockOffsetMs ?? 0); // rendererNow - daemonNow
  const toRendererClock = (daemonTs) => (Number.isFinite(daemonTs) ? daemonTs + clockOffsetMs : NaN);

  const ws = new Map();
  const page = new Map();
  const created = new Map();
  const published = new Map();
  const runtimeRecv = new Map();
  const postCommit = new Map();
  const serverFlushed = new Map();

  for (const sample of d.received || []) {
    const flushedAt = toRendererClock(sample.frame?.serverFlushedAt);
    for (const entry of sample.frame?.events || []) {
      const trace = entry.payload?.trace;
      const rt = toRendererClock(trace?.runtimeReceivedAt);
      const pc = toRendererClock(trace?.committedAt);
      const pub = toRendererClock(entry.emittedAt);
      for (const event of entry.payload?.events || []) {
        if (event?.sessionId !== d.session.id) continue;
        for (const key of markers(event.payload)) {
          first(ws, key, sample.at);
          first(published, key, pub);
          first(runtimeRecv, key, rt);
          first(postCommit, key, pc);
          first(serverFlushed, key, flushedAt);
        }
      }
    }
    if (sample.frame?.op === 'event') {
      const event = sample.frame.event;
      if (event?.sessionId === d.session.id) {
        for (const key of markers(event.payload)) first(ws, key, sample.at);
      }
    }
  }

  for (const sample of d.metrics?.received || []) {
    for (const entry of sample.batch?.events || []) {
      const trace = entry.payload?.trace;
      const rt = toRendererClock(trace?.runtimeReceivedAt);
      const pc = toRendererClock(trace?.committedAt);
      for (const event of entry.payload?.events || []) {
        if (event?.sessionId !== d.session.id) continue;
        for (const key of markers(event.payload)) {
          first(page, key, sample.at);
          first(runtimeRecv, key, rt);
          first(postCommit, key, pc);
        }
      }
    }
  }

  for (const event of d.events || []) {
    for (const key of markers(event.payload)) first(created, key, toRendererClock(event.createdAt));
  }

  const visible = (d.metrics?.visible || []).filter((v) => v.index < 1500);
  const byIndex = [...visible].sort((a, b) => a.index - b.index);
  const emitIntervals = byIndex.slice(1).map((v, i) => v.emitted - byIndex[i].emitted);
  const wsUpdates = [...new Set(ws.values())].sort((a, b) => a - b);
  const updates = [...new Set(visible.map((v) => v.at))].sort((a, b) => a - b);
  const intervals = updates.slice(1).map((at, i) => at - updates[i]);

  const pageMap = version === 'B2' ? ws : page.size > 0 ? page : ws;
  const pageLatencies = visible.filter((v) => pageMap.has(v.key)).map((v) => v.at - pageMap.get(v.key));
  const wsLatencies = visible.filter((v) => ws.has(v.key)).map((v) => v.at - ws.get(v.key));
  const emitLatencies = visible.map((v) => v.at - v.emitted);
  const runtimeLatencies = visible.filter((v) => runtimeRecv.has(v.key)).map((v) => v.at - runtimeRecv.get(v.key));
  const postCommitLatencies = visible.filter((v) => postCommit.has(v.key)).map((v) => v.at - postCommit.get(v.key));
  const runtimeToCommitLatencies = visible
    .filter((v) => runtimeRecv.has(v.key) && postCommit.has(v.key))
    .map((v) => postCommit.get(v.key) - runtimeRecv.get(v.key));
  const commitToWsLatencies = visible
    .filter((v) => postCommit.has(v.key) && ws.has(v.key))
    .map((v) => ws.get(v.key) - postCommit.get(v.key));
  const wsToPluginLatencies = visible
    .filter((v) => ws.has(v.key) && page.has(v.key))
    .map((v) => page.get(v.key) - ws.get(v.key));

  const inputPause = Math.max(0, ...intervals);
  const emitP95 = quantile(emitLatencies, 0.95);
  const pageP95 = quantile(pageLatencies, 0.95);
  const runtimeP95 = quantile(runtimeLatencies, 0.95);

  const serviceIds = new Set();
  let peakServiceSubscriptions = 0;
  for (const entry of d.sent || []) {
    if (entry.frame?.op === 'subscribe_service') serviceIds.add(entry.frame.subscriptionId);
    if (entry.frame?.op === 'unsubscribe_service') serviceIds.delete(entry.frame.subscriptionId);
    peakServiceSubscriptions = Math.max(peakServiceSubscriptions, serviceIds.size);
  }

  // Original total V8 heap snapshot calculation: sum of all renderer/iframe targets pre-GC
  let totalHeapBefore;
  let totalHeapAfter;
  let totalHeapAfterGc = null;
  if (Array.isArray(d.targetHeapsAfter) && d.targetHeapsAfter.length > 0) {
    totalHeapBefore = (d.targetHeapsBefore || []).reduce((s, x) => s + (x.usedSize || 0), 0);
    totalHeapAfter = d.targetHeapsAfter.reduce((s, x) => s + (x.usedSize || 0), 0);
    if (Array.isArray(d.targetHeapsAfterGc) && d.targetHeapsAfterGc.length > 0) {
      totalHeapAfterGc = d.targetHeapsAfterGc.reduce((s, x) => s + (x.usedSize || 0), 0);
    }
  } else {
    totalHeapBefore = d.heapBefore.usedSize + (version === 'B3' ? d.shellHeapBefore?.usedSize || 0 : 0);
    totalHeapAfter = d.heapAfter.usedSize + (version === 'B3' ? d.shellHeapAfter?.usedSize || 0 : 0);
  }

  runs.push({
    version,
    run,
    mountMode: d.mountMode ?? (version === 'B2' ? 'shell-builtin' : 'iframe'),
    file,
    historyEvents: d.fixture.historyEvents,
    fixtureBytes: d.fixture.historyBytes,
    fixtureDigest: d.fixture.digest,
    historyReadyMs: d.historyReadyMs,
    visibleMarkers: visible.length,
    matchedPageMarkers: pageLatencies.length,
    matchedRuntimeMarkers: runtimeLatencies.length,
    clockCalibration: d.clockCalibration ?? null,
    firstSegmentProxyMs: visible[0] ? visible[0].at - visible[0].emitted : null,
    pageReceiptToRenderedP95Ms: pageP95,
    wsToRenderedP95Ms: quantile(wsLatencies, 0.95),
    driverEmitToRenderedP95Ms: emitP95,
    exactRuntimeReceiveToRenderedP95Ms: runtimeP95,
    exactPostCommitToRenderedP95Ms: quantile(postCommitLatencies, 0.95),
    exactRuntimeToPostCommitP95Ms: quantile(runtimeToCommitLatencies, 0.95),
    exactPostCommitToHostWsP95Ms: quantile(commitToWsLatencies, 0.95),
    exactHostWsToPluginP95Ms: quantile(wsToPluginLatencies, 0.95),
    createdAtToRenderedP95Ms: quantile(
      visible.filter((v) => created.has(v.key)).map((v) => v.at - created.get(v.key)),
      0.95,
    ),
    postCommitPublishToRenderedP95Ms: quantile(
      visible.filter((v) => published.has(v.key)).map((v) => v.at - published.get(v.key)),
      0.95,
    ),
    updateIntervalP95Ms: quantile(intervals, 0.95),
    maxUpdateGapMs: inputPause,
    updatesPerSecond: Number((updates.length / 60).toFixed(2)),
    driverEmitIntervalP95Ms: quantile(emitIntervals, 0.95),
    driverMaxEmitGapMs: Math.max(0, ...emitIntervals),
    foregroundWsMaxGapMs: Math.max(0, ...wsUpdates.slice(1).map((at, i) => at - wsUpdates[i])),
    pageLongTasks: d.metrics.longTasks.length,
    pageLongestTaskMs: Math.max(0, ...d.metrics.longTasks.map((t) => t.duration)),
    shellLongTasks: d.shellLongTasks?.length ?? null,
    shellLongestTaskMs: Math.max(0, ...(d.shellLongTasks || []).map((t) => t.duration)),
    pageHeapBefore: d.heapBefore.usedSize,
    pageHeapAfter: d.heapAfter.usedSize,
    totalHeapBefore,
    totalHeapAfter,
    totalHeapAfterGc,
    targetCountAfter: Array.isArray(d.targetHeapsAfter) ? d.targetHeapsAfter.length : version === 'B3' ? 2 : 1,
    peakServiceSubscriptions,
    wsEventFrames: (d.received || []).length,
    finalDraftPreserved: d.finalDraftValue !== undefined ? d.finalDraftValue === '性能输入 65' : null,
    exceptions: (d.exceptions || []).length,
    daemonQueues: d.daemonDiagnostics?.queues ?? null,
    daemonActiveSubscriptions: d.daemonDiagnostics?.activeSubscriptions ?? null,
    daemonActiveTimers: d.daemonDiagnostics?.activeTimers ?? null,
    frontendDiagnostics: d.frontendDiagnostics
      ? {
          activePluginSubscriptions: d.frontendDiagnostics.activePluginSubscriptions,
          activePluginTimers: d.frontendDiagnostics.activePluginTimers,
          pluginQueueDepth: d.frontendDiagnostics.pluginQueueDepth,
          pluginQueueHighWater: d.frontendDiagnostics.pluginQueueHighWater,
          pluginMaxBacklogMs: d.frontendDiagnostics.pluginMaxBacklogMs,
          pluginBatchCount: d.frontendDiagnostics.pluginBatchCount,
          pluginMaxBatchSize: d.frontendDiagnostics.pluginMaxBatchSize,
          hostWsFrames: d.frontendDiagnostics.hostWsFrames,
        }
      : null,
    absoluteBudgets: {
      pageP95: pageP95 !== null && pageP95 <= 100,
      runtimeP95Exact: runtimeP95 !== null ? runtimeP95 <= 200 : null,
      emitUpperBoundP95: emitP95 !== null && emitP95 <= 200,
      no500msPause: inputPause <= 500,
    },
    limits: d.telemetryLimits,
  });
}

for (const version of ['B2', 'B3']) {
  for (let run = 1; run <= 3; run++) {
    const file = path.join(b2b3Root, `${version.toLowerCase()}-${run}`, 'raw.json');
    if (fs.existsSync(file)) analyzeRun(version, run, file);
  }
}

for (let run = 1; run <= 3; run++) {
  const file = path.join(b4Root, `b4-${run}`, 'raw.json');
  if (fs.existsSync(file)) analyzeRun('B4', run, file);
}

const comparableMetrics = [
  'historyReadyMs',
  'firstSegmentProxyMs',
  'pageReceiptToRenderedP95Ms',
  'wsToRenderedP95Ms',
  'driverEmitToRenderedP95Ms',
  'updateIntervalP95Ms',
  'maxUpdateGapMs',
  'pageLongestTaskMs',
  'totalHeapAfter',
];

const comparisons = comparableMetrics.map((metric) => {
  const b2 = quantile(runs.filter((r) => r.version === 'B2').map((r) => r[metric]), 0.5);
  const b3 = quantile(runs.filter((r) => r.version === 'B3').map((r) => r[metric]), 0.5);
  const b4 = quantile(runs.filter((r) => r.version === 'B4').map((r) => r[metric]), 0.5);
  return {
    metric,
    b2Median: b2,
    b3Median: b3,
    b4Median: b4,
    b3VsB2Percent: b2 && b3 !== null ? Number((100 * (b3 / b2 - 1)).toFixed(2)) : null,
    b4VsB2Percent: b2 && b4 !== null ? Number((100 * (b4 / b2 - 1)).toFixed(2)) : null,
    b4Within10PercentOfB2: b2 && b4 !== null ? b4 <= b2 * 1.1 : null,
  };
});

const b4Runs = runs.filter((r) => r.version === 'B4');
const b4Medians = {
  historyReadyMs: quantile(b4Runs.map((r) => r.historyReadyMs), 0.5),
  pageReceiptToRenderedP95Ms: quantile(b4Runs.map((r) => r.pageReceiptToRenderedP95Ms), 0.5),
  exactRuntimeReceiveToRenderedP95Ms: quantile(b4Runs.map((r) => r.exactRuntimeReceiveToRenderedP95Ms), 0.5),
  exactPostCommitToRenderedP95Ms: quantile(b4Runs.map((r) => r.exactPostCommitToRenderedP95Ms), 0.5),
  driverEmitToRenderedP95Ms: quantile(b4Runs.map((r) => r.driverEmitToRenderedP95Ms), 0.5),
  maxUpdateGapMs: quantile(b4Runs.map((r) => r.maxUpdateGapMs), 0.5),
  totalHeapAfter: quantile(b4Runs.map((r) => r.totalHeapAfter), 0.5),
  totalHeapAfterGc: quantile(b4Runs.map((r) => r.totalHeapAfterGc), 0.5),
};

const allB4AbsolutePass =
  b4Runs.length === 3 &&
  b4Runs.every(
    (r) =>
      r.absoluteBudgets.pageP95 &&
      r.absoluteBudgets.runtimeP95Exact === true &&
      r.absoluteBudgets.no500msPause &&
      r.visibleMarkers === 1500 &&
      r.exceptions === 0 &&
      r.finalDraftPreserved !== false,
  );

const keyRelativePass = ['historyReadyMs', 'pageReceiptToRenderedP95Ms', 'wsToRenderedP95Ms', 'driverEmitToRenderedP95Ms', 'totalHeapAfter'].every(
  (m) => comparisons.find((c) => c.metric === m)?.b4Within10PercentOfB2 === true,
);

const result = {
  machine: {
    cpu: 'Intel Core i7-1165G7',
    physicalCores: 4,
    logicalProcessors: 8,
    physicalMemoryBytes: 16969424896,
    os: 'Windows 10 10.0.19045',
    electron: '35.7.5',
    gpu: '--disable-gpu',
  },
  budgetsUnchanged: {
    pageP95Ms: 100,
    runtimeP95Ms: 200,
    maxPauseMs: 500,
    maxRegressionPercent: 10,
    historyReadyMedianCapMs: 1290.3,
    totalHeapAfterMedianCapBytes: 24133564,
  },
  runs,
  comparisons,
  b4Medians,
  verdict: {
    b4RunsCount: b4Runs.length,
    allB4AbsoluteBudgetsPass: allB4AbsolutePass,
    keyRelativeRegressionsWithin10Percent: keyRelativePass,
    closesB3A8AndPassesB4A8: allB4AbsolutePass && keyRelativePass,
    historicalB3A8Status: 'Original B3-A8 failed (historyReadyMs 1654ms > 1290.3ms, totalHeapAfter +61.75%, maxUpdateGap 524/606/756ms > 500ms); retained for historical record and evaluated against new B4 candidate.',
    telemetryNotes: [
      'B2 binary does not emit exact runtime-entry or post-commit telemetry; B4 validates exact absolute budgets while B2 proxies are used only for same-boundary relative comparisons.',
      'createdAt is not post-commit time; DOM+2rAF is not OS compositor presentation; post-GC retained heap is supplemental only.',
    ],
  },
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output, runs: runs.length, b4Medians, verdict: result.verdict }, null, 2));
