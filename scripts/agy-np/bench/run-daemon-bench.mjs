#!/usr/bin/env node
/**
 * NP-16 Reproducible T18 Daemon Benchmark (Disabled vs Enabled Baseline)
 *
 * Measures against built `@harnessmate/daemon` & `@harnessmate/protocol` artifacts:
 * - Scenario 0 (Gates Off): Default `DEFAULT_AGY_NATIVE_FEATURE_FLAGS` (disabled) + legacy baseline
 * - Scenario 1 (10,000 Events): `commitAndPublish`, opaque cursor pagination (20x500), WS replay + >10k overflow resync
 * - Scenario 2 (100 Agents): 100 agents + 99 relations + 200 status updates + 50 projection reads
 * - Scenario 3 (20 Pending Requests): `NativePermissionRouter` enqueue + concurrent `resolveWithCas` & double-resolve race
 * - DB footprint: `.sqlite` / `-wal` / `-shm` bytes, `PRAGMA page_count`, `page_size`, `freelist_count`, row counts
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from '../../../packages/daemon/node_modules/ws/wrapper.mjs';
import {
  asActivityId,
  asNativeAgentId,
  asWorkId,
  sanitizeAgentIdentityForPublic,
  sanitizeNativeWorkForPublic,
} from '../../../packages/protocol/dist/index.js';
import { HarnessMateStore } from '../../../packages/daemon/dist/db/sqlite.js';
import {
  AgyNativeRuntimeRegistry,
  DEFAULT_AGY_NATIVE_FEATURE_FLAGS,
} from '../../../packages/daemon/dist/harnesses/agy/native/wiring/index.js';
import {
  NativePermissionRouter,
  StubNativeRequestTargetResolver,
} from '../../../packages/daemon/dist/harnesses/agy/native/requests/index.js';
import { createDaemon } from '../../../packages/daemon/dist/server/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function parseArgs(argv) {
  const opts = {
    samples: 3,
    events: 10_000,
    agents: 100,
    requests: 20,
    tmpRoot: process.env.HM_BENCH_TMP || 'D:\\AppDataCache\\np16-bench',
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--samples' && argv[i + 1]) opts.samples = Math.max(1, Number(argv[++i]) || 3);
    else if (arg === '--events' && argv[i + 1]) opts.events = Math.max(100, Number(argv[++i]) || 10_000);
    else if (arg === '--agents' && argv[i + 1]) opts.agents = Math.max(2, Number(argv[++i]) || 100);
    else if (arg === '--requests' && argv[i + 1]) opts.requests = Math.max(1, Number(argv[++i]) || 20);
    else if (arg === '--tmp-root' && argv[i + 1]) opts.tmpRoot = argv[++i];
    else if (arg === '--out' && argv[i + 1]) opts.out = argv[++i];
  }
  return opts;
}

function summarize(samplesMs) {
  if (!samplesMs || samplesMs.length === 0) {
    return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, totalMs: 0 };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pick = (q) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return Number(sorted[idx].toFixed(4));
  };
  return {
    count: sorted.length,
    meanMs: Number((sum / sorted.length).toFixed(4)),
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    maxMs: Number(sorted[sorted.length - 1].toFixed(4)),
    totalMs: Number(sum.toFixed(2)),
  };
}

function rssSnapshot() {
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    heapTotalBytes: m.heapTotal,
    externalBytes: m.external,
    rssMiB: Number((m.rss / (1024 * 1024)).toFixed(2)),
    heapUsedMiB: Number((m.heapUsed / (1024 * 1024)).toFixed(2)),
  };
}

function readSqliteStats(store, fallbackDbPath) {
  const db = store.getDatabaseSync();
  const pragma = (name) => {
    const row = db.prepare(`PRAGMA ${name}`).get();
    return row ? Object.values(row)[0] : null;
  };
  const dbList = db.prepare('PRAGMA database_list').all();
  const mainEntry = dbList.find((r) => r && r.name === 'main');
  const dbPath = typeof mainEntry?.file === 'string' && mainEntry.file ? mainEntry.file : fallbackDbPath;
  const countTable = (tbl) => {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${tbl}`).get();
    return Number(row?.cnt ?? 0);
  };
  const fileSize = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
  return {
    dbFileName: path.basename(dbPath),
    sqliteVersion: String(db.prepare('SELECT sqlite_version() AS v').get()?.v ?? 'unknown'),
    mainBytes: fileSize(dbPath),
    walBytes: fileSize(`${dbPath}-wal`),
    shmBytes: fileSize(`${dbPath}-shm`),
    totalDiskBytes: fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`),
    pageCount: Number(pragma('page_count') ?? 0),
    pageSize: Number(pragma('page_size') ?? 0),
    freelistCount: Number(pragma('freelist_count') ?? 0),
    rowCounts: {
      sessions: countTable('sessions'),
      session_events: countTable('session_events'),
      native_runtime_bindings: countTable('native_runtime_bindings'),
      native_runtime_entities: countTable('native_runtime_entities'),
      native_runtime_relations: countTable('native_runtime_relations'),
      native_runtime_events: countTable('native_runtime_events'),
      native_runtime_receipts: countTable('native_runtime_receipts'),
    },
  };
}

function makeTempDir(tmpRoot, prefix) {
  fs.mkdirSync(tmpRoot, { recursive: true });
  return fs.mkdtempSync(path.join(tmpRoot, prefix));
}

function seedSession(store, cwd, harnessId = 'agy', harnessKind = 'agy') {
  const ws = store.createWorkspace({
    id: `ws_${crypto.randomBytes(4).toString('hex')}`,
    name: 'Bench WS',
    rootPath: path.join(cwd, `ws_${crypto.randomBytes(3).toString('hex')}`),
    isGitRepo: false,
    gitBranch: null,
    createdAt: Date.now(),
  });
  const sess = store.createSession({
    id: `sess_${crypto.randomBytes(4).toString('hex')}`,
    workspaceId: ws.id,
    harnessId,
    harnessKind,
    nativeSessionId: harnessKind === 'agy' ? 'nat_bench_root' : null,
    cwd: ws.rootPath,
    worktreeBranch: null,
    title: 'Benchmark Session',
    status: 'idle',
    model: harnessKind === 'agy' ? 'gemini-3.8-flash' : 'gpt-5',
    reasoningEffort: 'medium',
    permissionMode: 'manual',
    lastSeq: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return { ws, sess };
}

function getGitInfo() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    return { sha, branch };
  } catch {
    return { sha: 'unknown', branch: 'unknown' };
  }
}

async function runDisabledBaseline(opts, tempDirs) {
  const dir = makeTempDir(opts.tmpRoot, 'daemon-off-');
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'bench-off.sqlite');
  const rssBefore = rssSnapshot();
  const store = new HarnessMateStore(dbPath);
  const registry = new AgyNativeRuntimeRegistry(store); // defaults strictly to DEFAULT_AGY_NATIVE_FEATURE_FLAGS (all false)
  const flags = registry.getFeatureFlags();
  const { sess } = seedSession(store, dir, 'codex', 'codex');

  const legacyCommitLatencies = [];
  const tStart = performance.now();
  for (let i = 1; i <= opts.events; i += 1) {
    const t0 = performance.now();
    store.appendEvent(sess.id, 'message.delta', { delta: `chunk-${i}` }, 'turn_bench_off');
    legacyCommitLatencies.push(performance.now() - t0);
  }
  const legacyTotalMs = performance.now() - tStart;

  const projCheckLatencies = [];
  for (let i = 0; i < 50; i += 1) {
    const t0 = performance.now();
    registry.getProjectionForSession(sess.id, 'agy');
    projCheckLatencies.push(performance.now() - t0);
  }

  const dbStats = readSqliteStats(store, dbPath);
  const rssAfter = rssSnapshot();
  store.close();

  return {
    mode: 'gates_off_baseline',
    defaultFlags: flags,
    legacyAppendEvents: opts.events,
    legacyThroughputOpsPerSec: Number((opts.events / (legacyTotalMs / 1000)).toFixed(1)),
    legacyCommitLatency: summarize(legacyCommitLatencies),
    disabledProjectionReadLatency: summarize(projCheckLatencies),
    dbStats,
    rssBefore,
    rssAfter,
  };
}

async function runEnabledSample(opts, tempDirs, runIndex) {
  const dir = makeTempDir(opts.tmpRoot, `daemon-on-${runIndex}-`);
  tempDirs.push(dir);
  const dataDir = path.join(dir, 'data');
  const dbPath = path.join(dataDir, 'harnessmate.sqlite');
  const rssBefore = rssSnapshot();

  const daemon = createDaemon({ dataDir, port: 0, webDistDir: null });
  try {
    const { port } = await daemon.start();
    const { sess } = seedSession(daemon.store, dir, 'agy', 'agy');
    daemon.nativeRegistry.setFeatureFlags({
      enabled: true,
      nativeLifecycle: true,
      nativePermissions: true,
      nativeCommands: true,
    });
    const storedBinding = daemon.nativeRegistry.ensureRuntimeBinding({
      sessionId: sess.id,
      instanceId: 'agy',
      profileRef: 'agy:bench-profile',
      sourceRef: 'agy_cli',
      status: 'attached',
    });
    const binding = {
      runtimeId: storedBinding.runtimeId,
      sessionId: storedBinding.sessionId,
      instanceId: storedBinding.instanceId,
      generation: storedBinding.generation,
    };

    const evEvidence = {
      kind: 'live_protocol',
      connectionId: 'conn_bench_1',
      ingressOrdinal: 1,
      wireVariant: 'acp_v1',
      observedAt: Date.now(),
    };

    // 1. 10,000 events
    const commitLatencies = [];
    const tEventsStart = performance.now();
    for (let i = 1; i <= opts.events; i += 1) {
      const workId = asWorkId(`wrk_bench_${i % 64}`);
      const actId = asActivityId(`act_bench_${i % 16}`);
      const work = {
        id: workId,
        kind: i % 5 === 0 ? 'daemon' : 'finite_command',
        blocking: i % 5 === 0 ? 'detached' : 'confirmed_blocking',
        state: { kind: 'known', value: i % 10 === 0 ? 'finished' : 'running', evidence: evEvidence },
        observedLabel: `bench-work-${i % 64}`,
        revision: i,
      };
      const t0 = performance.now();
      daemon.nativeRegistry.commitAndPublish(
        binding,
        i % 10 === 1
          ? {
              activities: [{
                id: actId,
                turnId: null,
                origin: 'native_continuation',
                state: 'running',
                updatedAt: Date.now(),
              }],
              work: [work],
            }
          : { work: [work] },
        {
          type: 'native.work.changed',
          turnId: null,
          payload: { work: sanitizeNativeWorkForPublic(work) },
        },
      );
      commitLatencies.push(performance.now() - t0);
    }
    const totalEventsMs = performance.now() - tEventsStart;

    // 1b. Cursor pagination across all 10,000 events (limit = 500)
    const pageLatencies = [];
    let cursor = undefined;
    let totalRead = 0;
    const tPagStart = performance.now();
    while (true) {
      const t0 = performance.now();
      const page = daemon.nativeRegistry.readEventsForSession(sess.id, 'agy', {
        afterSeq: 0,
        limit: 500,
        cursor,
      });
      pageLatencies.push(performance.now() - t0);
      totalRead += page.events.length;
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const totalPaginateMs = performance.now() - tPagStart;

    // 1c. WebSocket 10,000-event replay measurement (when runIndex === 0)
    let wsReplay = null;
    if (runIndex === 0) {
      const wsCount = { received: 0, replayLastSeq: null, overflowResyncReason: null };
      const wsStart = performance.now();
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/api/v1/sessions/${sess.id}/native/ws?token=${encodeURIComponent(daemon.config.localToken)}`,
        );
        ws.on('error', reject);
        ws.on('message', (raw) => {
          const frame = JSON.parse(raw.toString('utf8'));
          if (frame.op === 'native_hello') {
            ws.send(JSON.stringify({ op: 'subscribe_native', schemaVersion: 1, afterSeq: 0 }));
          } else if (frame.op === 'native_event') {
            wsCount.received += 1;
          } else if (frame.op === 'native_replay_complete') {
            wsCount.replayLastSeq = frame.lastSeq;
            ws.close();
            resolve();
          } else if (frame.op === 'native_resync_required') {
            wsCount.overflowResyncReason = frame.reason;
            ws.close();
            resolve();
          }
        });
      });
      const wsElapsedMs = performance.now() - wsStart;
      wsReplay = {
        ...wsCount,
        elapsedMs: Number(wsElapsedMs.toFixed(2)),
        throughputEventsPerSec: Number((wsCount.received / (wsElapsedMs / 1000)).toFixed(1)),
      };
    }

    // 2. 100 Agents (1 coordinator + (N-1) subagents) + relations + updates + projection reads
    const rootAgentId = asNativeAgentId('ag_bench_root');
    const agentRegLatencies = [];
    const tAgentsStart = performance.now();
    {
      const agents = [{
        id: rootAgentId,
        role: { kind: 'known', value: 'coordinator', evidence: evEvidence },
        label: { kind: 'known', value: 'Bench Coordinator', evidence: evEvidence },
        foreground: { kind: 'known', value: 'running', evidence: evEvidence },
        launchWorkIds: [],
        lineage: 'confirmed',
        revision: 1,
      }];
      const relations = [];
      for (let a = 1; a < opts.agents; a += 1) {
        const childId = asNativeAgentId(`ag_bench_child_${a}`);
        agents.push({
          id: childId,
          role: { kind: 'known', value: `worker-${a % 5}`, evidence: evEvidence },
          label: { kind: 'known', value: `Worker #${a}`, evidence: evEvidence },
          foreground: { kind: 'known', value: a % 3 === 0 ? 'running' : 'idle', evidence: evEvidence },
          launchWorkIds: [],
          lineage: 'confirmed',
          revision: 1,
        });
        relations.push({
          parentAgentId: rootAgentId,
          childAgentId: childId,
          confidence: 'protocol_confirmed',
          evidence: evEvidence,
        });
      }
      const t0 = performance.now();
      daemon.nativeRegistry.commitAndPublish(
        binding,
        { agents, relationsUpsert: relations },
        {
          type: 'native.agent.changed',
          turnId: null,
          payload: { agent: sanitizeAgentIdentityForPublic(agents[0]) },
        },
      );
      agentRegLatencies.push(performance.now() - t0);

      for (let u = 1; u <= 200; u += 1) {
        const idx = 1 + (u % (opts.agents - 1));
        const ag = {
          id: asNativeAgentId(`ag_bench_child_${idx}`),
          role: { kind: 'known', value: `worker-${idx % 5}`, evidence: evEvidence },
          label: { kind: 'known', value: `Worker #${idx}`, evidence: evEvidence },
          foreground: { kind: 'known', value: u % 2 === 0 ? 'idle' : 'running', evidence: evEvidence },
          launchWorkIds: [],
          lineage: 'confirmed',
          revision: u + 1,
        };
        const tu = performance.now();
        daemon.nativeRegistry.commitAndPublish(
          binding,
          { agents: [ag] },
          { type: 'native.agent.changed', turnId: null, payload: { agent: sanitizeAgentIdentityForPublic(ag) } },
        );
        agentRegLatencies.push(performance.now() - tu);
      }
    }
    const totalAgentsMs = performance.now() - tAgentsStart;

    const projReadLatencies = [];
    let projectionBytes = 0;
    for (let r = 0; r < 50; r += 1) {
      const t0 = performance.now();
      const proj = daemon.nativeRegistry.getProjectionForSession(sess.id, 'agy');
      projReadLatencies.push(performance.now() - t0);
      if (r === 0) projectionBytes = Buffer.byteLength(JSON.stringify(proj), 'utf8');
    }

    // 3. 20 Concurrent Pending Requests + CAS Race
    const resolver = new StubNativeRequestTargetResolver();
    resolver.registerRootSession(binding, 'conn_bench_req', 'nat_bench_root');
    const router = new NativePermissionRouter(daemon.nativeRegistry, { targetResolver: resolver });
    daemon.nativeRegistry.registerModules({ permissions: router });

    let wireWrites = 0;
    const createdIds = [];
    const enqueueLatencies = [];
    for (let q = 0; q < opts.requests; q += 1) {
      const t0 = performance.now();
      router.onIncomingRequest({
        binding,
        connectionId: 'conn_bench_req',
        ingressOrdinal: 20_000 + q,
        channel: 'live',
        wireRequestId: `bench_req_${q}`,
        method: 'session/request_permission',
        params: {
          sessionId: 'nat_bench_root',
          toolCall: { toolCallId: `tc_req_${q}`, title: `Run check #${q}`, kind: 'execute' },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
          ],
        },
        respond: () => {
          wireWrites += 1;
          return true;
        },
        respondError: () => true,
      });
      enqueueLatencies.push(performance.now() - t0);
    }
    for (const p of router.listPendingRequests(binding)) {
      createdIds.push(p.approvalId);
    }

    const resolveLatencies = [];
    const raceOutcomes = await Promise.all(
      createdIds.flatMap((approvalId, idx) => [
        (async () => {
          const t0 = performance.now();
          const res = await router.resolveWithCas({
            binding,
            approvalId,
            request: {
              generation: binding.generation,
              outcome: 'selected',
              optionId: 'allow_once',
              idempotencyKey: `idem_win_${idx}`,
            },
            resolvedBy: 'desktop',
          });
          resolveLatencies.push(performance.now() - t0);
          return res;
        })(),
        router.resolveWithCas({
          binding,
          approvalId,
          request: {
            generation: binding.generation,
            outcome: 'selected',
            optionId: 'reject_once',
            idempotencyKey: `idem_lose_${idx}`,
          },
          resolvedBy: 'remote',
        }),
      ]),
    );
    router.dispose();

    const successCount = raceOutcomes.filter((r) => !r.conflict && r.receiptState === 'response_written').length;
    const conflictCount = raceOutcomes.filter((r) => r.conflict).length;

    const dbStats = readSqliteStats(daemon.store, dbPath);
    const rssAfter = rssSnapshot();

    return {
      runIndex,
      events: {
        count: opts.events,
        totalMs: Number(totalEventsMs.toFixed(2)),
        throughputPerSec: Number((opts.events / (totalEventsMs / 1000)).toFixed(1)),
        commitLatency: summarize(commitLatencies),
        paginate500: {
          pages: pageLatencies.length,
          totalRead,
          totalMs: Number(totalPaginateMs.toFixed(2)),
          pageLatency: summarize(pageLatencies),
        },
        wsReplay,
      },
      agents: {
        agentCount: opts.agents,
        updateEvents: 200,
        totalMs: Number(totalAgentsMs.toFixed(2)),
        commitLatency: summarize(agentRegLatencies),
        projectionRead50: summarize(projReadLatencies),
        projectionJsonBytes: projectionBytes,
      },
      requests: {
        pendingCount: createdIds.length,
        wireWrites,
        casWinners: successCount,
        casConflicts: conflictCount,
        enqueueLatency: summarize(enqueueLatencies),
        concurrentResolveLatency: summarize(resolveLatencies),
      },
      dbStats,
      rssBefore,
      rssAfter,
      legacySessionLastSeqIntact: daemon.store.getSession(sess.id)?.lastSeq === 0,
    };
  } finally {
    await daemon.stop().catch(() => {});
  }
}

export async function runDaemonBench(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const tempDirs = [];
  const startWall = Date.now();
  try {
    const disabled = await runDisabledBaseline(opts, tempDirs);
    const runs = [];
    for (let i = 0; i < opts.samples; i += 1) {
      runs.push(await runEnabledSample(opts, tempDirs, i));
    }

    const report = {
      schemaVersion: 1,
      suite: 'np16-t18-daemon-bench',
      timestamp: new Date(startWall).toISOString(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        totalMemoryMiB: Number((os.totalmem() / (1024 * 1024)).toFixed(0)),
        sqliteVersion: runs[0]?.dbStats.sqliteVersion ?? disabled.dbStats.sqliteVersion,
        git: getGitInfo(),
        tmpRoot: opts.tmpRoot,
      },
      parameters: {
        samples: opts.samples,
        events: opts.events,
        agents: opts.agents,
        requests: opts.requests,
      },
      disabledBaseline: disabled,
      enabledRuns: runs,
      enabledAggregates: {
        eventCommitP95MeanMs: Number(
          (runs.reduce((a, r) => a + r.events.commitLatency.p95Ms, 0) / runs.length).toFixed(4),
        ),
        eventThroughputMeanPerSec: Number(
          (runs.reduce((a, r) => a + r.events.throughputPerSec, 0) / runs.length).toFixed(1),
        ),
        paginateTotalMeanMs: Number(
          (runs.reduce((a, r) => a + r.events.paginate500.totalMs, 0) / runs.length).toFixed(2),
        ),
        projectionReadP95MeanMs: Number(
          (runs.reduce((a, r) => a + r.agents.projectionRead50.p95Ms, 0) / runs.length).toFixed(4),
        ),
        requestCasResolveP95MeanMs: Number(
          (runs.reduce((a, r) => a + r.requests.concurrentResolveLatency.p95Ms, 0) / runs.length).toFixed(4),
        ),
        peakRssMiB: Math.max(...runs.map((r) => r.rssAfter.rssMiB)),
        dbTotalDiskBytesRun0: runs[0]?.dbStats.totalDiskBytes ?? 0,
      },
    };

    if (opts.out) {
      fs.mkdirSync(path.dirname(path.resolve(REPO_ROOT, opts.out)), { recursive: true });
      fs.writeFileSync(path.resolve(REPO_ROOT, opts.out), JSON.stringify(report, null, 2));
    }
    return report;
  } finally {
    for (const dir of tempDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runDaemonBench()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
