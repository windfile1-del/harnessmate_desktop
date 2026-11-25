import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGY_NATIVE_CONTRACT_REVISION,
  AGY_NATIVE_CONTRACT_VERSION,
  AGY_NATIVE_MIGRATION_COMPONENT,
  asActivityId,
  asBindingGeneration,
  asWorkId,
  asWorkflowId,
  type NativeWork,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import { ContextCompiler } from '../src/core/context-compiler.js';
import { TaskLedgerService } from '../src/core/task-ledger-service.js';
import { HarnessMateStore } from '../src/db/sqlite.js';
import {
  readAgyIndexedHistoryDetailedFromRoot,
  readAgyIndexedHistoryFromRoot,
  scanAgyRoot,
} from '../src/harnesses/history-scanner.js';
import {
  AcpV1ProtocolCodec,
  AgyNativeRecoveryService,
  AgyProcessTreeTeardownCoordinator,
  AgyRecoveryHistorySource,
  buildInitializeRequest,
  createAcpV2PreviewCodec,
  evaluateCliVersionCompatibility,
  negotiateAcpProtocol,
  selectAttachStrategy,
  type TeardownTransport,
} from '../src/harnesses/agy/native/recovery/index.js';
import { AgyNativeRuntimeRegistry } from '../src/harnesses/agy/native/wiring/registry.js';
import { PluginEvents } from '../src/plugin-host/runtime/events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NP15_FIXTURES_DIR = path.join(__dirname, 'fixtures', 'agy-np15');

const tempDirs: string[] = [];
const openStores: HarnessMateStore[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function openStore(dbPath: string): HarnessMateStore {
  const store = new HarnessMateStore(dbPath);
  openStores.push(store);
  return store;
}

function loadNdjsonFixtures(fileName: string): Map<string, Record<string, any>> {
  const raw = fs.readFileSync(path.join(NP15_FIXTURES_DIR, fileName), 'utf8').trim();
  const map = new Map<string, Record<string, any>>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as Record<string, any>;
    if (typeof parsed.case === 'string') {
      map.set(parsed.case, parsed);
    }
  }
  return map;
}

function seedSession(
  store: HarnessMateStore,
  wsDir: string,
  opts?: { sessionId?: string; instanceId?: string; nativeSessionId?: string | null },
) {
  const now = 1_764_000_000_000;
  const wsId = `ws_${Math.random().toString(36).slice(2, 8)}`;
  store.createWorkspace({
    id: wsId,
    name: 'NP15-WS',
    rootPath: wsDir,
    isGitRepo: false,
    gitBranch: null,
    createdAt: now,
  });
  return store.createSession({
    id: opts?.sessionId ?? `sess_${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: wsId,
    harnessId: opts?.instanceId ?? 'agy',
    harnessKind: 'agy',
    nativeSessionId: opts?.nativeSessionId ?? '11111111-1111-4111-8111-111111111111',
    cwd: wsDir,
    worktreeBranch: null,
    title: 'NP-15 Recovery Session',
    status: 'idle',
    model: 'gemini-3.8-flash',
    reasoningEffort: 'medium',
    permissionMode: 'manual',
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  });
}

function createFakeAgySummaryDb(
  rootDir: string,
  sessionId: string,
  opts?: { walMode?: boolean; dropWalShmAfterWrite?: boolean },
): string {
  fs.mkdirSync(rootDir, { recursive: true });
  const dbPath = path.join(rootDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  if (opts?.walMode) {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      workspace_uris TEXT,
      last_modified_time TEXT
    );
    CREATE TABLE conversations_fts (
      conversation_id TEXT,
      chunk_index INTEGER,
      user_body TEXT,
      agent_body TEXT,
      user_step_byte_offsets TEXT,
      agent_step_byte_offsets TEXT
    );
  `);
  db.prepare(
    `INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)`,
  ).run(sessionId, 'Indexed AGY Session', JSON.stringify([`file:///D:/work/repo`]), '2026-11-26T00:00:00.000Z');

  const userText = 'Explain NP-15 recovery';
  const agentText = 'Recovery marks attached sessions reconciling.';
  db.prepare(
    `INSERT INTO conversations_fts VALUES (?, 0, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userText,
    agentText,
    JSON.stringify([[0, 0]]),
    JSON.stringify([[1, 0]]),
  );
  db.close();

  if (opts?.dropWalShmAfterWrite) {
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore if absent
      }
    }
  }
  return dbPath;
}

afterEach(() => {
  while (openStores.length > 0) {
    try {
      openStores.pop()?.close();
    } catch {
      // ignore close errors
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

describe('NP-15 Session Recovery & Protocol Compatibility', () => {
  // ── 1. Startup, Legacy/New/Newer DB & Gate Rollback (T14) ────────────

  it('Suite 1: handles pre-NP-02 legacy DB, active startup reconcile, newer-schema fail-closed, and rollback gate OFF', () => {
    // 1a. Pre-NP-02 legacy DB migration preserves old rows and allows clean startup
    const legacyDir = makeTempDir('np15-legacy-');
    const legacyDbPath = path.join(legacyDir, 'legacy.sqlite');
    const raw = new DatabaseSync(legacyDbPath);
    raw.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        is_git_repo INTEGER NOT NULL DEFAULT 0,
        git_branch TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        harness_id TEXT NOT NULL,
        harness_kind TEXT NOT NULL,
        native_session_id TEXT,
        cwd TEXT NOT NULL,
        worktree_branch TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        reasoning_effort TEXT,
        permission_mode TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO workspaces VALUES ('ws_legacy', 'Legacy', 'D:\\legacy', 0, NULL, 100);
      INSERT INTO sessions VALUES ('sess_legacy', 'ws_legacy', 'agy', 'agy', 'nat_legacy', 'D:\\legacy', NULL, 'Legacy AGY', 'idle', NULL, NULL, 'manual', 4, NULL, 100, 200);
    `);
    raw.close();

    const legacyStore = openStore(legacyDbPath);
    const legacyRegistry = new AgyNativeRuntimeRegistry(legacyStore, { enabled: true });
    const legacyRecovery = new AgyNativeRecoveryService({
      registry: legacyRegistry,
      config: { activeReconcileEnabled: true },
    });
    const legacyStartup = legacyRecovery.reconcileOnDaemonStartup({
      sessionScopes: [{ sessionId: 'sess_legacy', instanceId: 'agy' }],
    });
    expect(legacyStartup.skipped).toBe(false);
    expect(legacyStartup.reconciledBindings).toBe(0);
    expect(legacyStore.getSession('sess_legacy')?.title).toBe('Legacy AGY');
    expect(legacyStore.getSession('sess_legacy')?.lastSeq).toBe(4);

    // 1b. Active startup reconcile transitions attached bindings -> reconciling & invalidates pending/claimed approvals
    const activeDir = makeTempDir('np15-active-');
    const activeStore = openStore(path.join(activeDir, 'active.sqlite'));
    const wsDir = makeTempDir('np15-ws-');
    const sess = seedSession(activeStore, wsDir, { sessionId: 'sess_active', instanceId: 'agy' });
    const registry = new AgyNativeRuntimeRegistry(activeStore, { enabled: true });
    const stored = registry.ensureRuntimeBinding({
      sessionId: sess.id,
      instanceId: 'agy',
      profileRef: 'agy:default',
      sourceRef: 'acp',
      generation: asBindingGeneration('gen_1'),
      status: 'attached',
    });
    const binding: RuntimeBinding = {
      runtimeId: stored.runtimeId,
      sessionId: stored.sessionId,
      instanceId: stored.instanceId,
      generation: stored.generation,
    };

    const actId = asActivityId('act_run_1');
    const workId = asWorkId('wrk_run_1');
    const now = 1_764_000_010_000;
    registry.commitAndPublish(
      binding,
      {
        activities: [
          {
            id: actId,
            turnId: 'turn_1',
            origin: 'user_turn',
            workId,
            state: 'waiting_background',
            updatedAt: now,
          },
        ],
        work: [
          {
            id: workId,
            kind: 'finite_command',
            originActivityId: actId,
            blocking: 'confirmed_blocking',
            state: {
              kind: 'known',
              value: 'running',
              evidence: {
                kind: 'live_protocol',
                connectionId: 'conn_before_crash',
                ingressOrdinal: 1,
                wireVariant: 'agy-acp-v1',
                observedAt: now,
              },
            },
            revision: 1,
          },
        ],
      },
      {
        type: 'native.work.changed',
        turnId: 'turn_1',
        payload: {
          work: {
            id: workId,
            kind: 'finite_command',
            originActivityId: actId,
            blocking: 'confirmed_blocking',
            state: {
              kind: 'known',
              value: 'running',
              evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: now },
            },
            revision: 1,
          },
        },
      },
    );
    registry.persistence.createPendingApprovalReceipt({ binding, approvalId: 'appr_pending_1' });
    registry.persistence.createPendingApprovalReceipt({ binding, approvalId: 'appr_claimed_1' });
    registry.persistence.claimApprovalReceiptCas({
      approvalId: 'appr_claimed_1',
      expectedGeneration: binding.generation,
      expectedSessionId: binding.sessionId,
    });

    const eventsSeen: string[] = [];
    registry.subscribeSession(sess.id, (ev) => eventsSeen.push(ev.type));

    // Rollback gate OFF (`activeReconcileEnabled: false`): zero mutations, historical feed still readable
    const recoveryOff = new AgyNativeRecoveryService({
      registry,
      config: { activeReconcileEnabled: false },
    });
    const offRes = recoveryOff.reconcileOnDaemonStartup({
      sessionScopes: [{ sessionId: sess.id, instanceId: 'agy' }],
    });
    expect(offRes.skipped).toBe(true);
    expect(offRes.reasonCode).toBe('active_reconcile_disabled');
    expect(registry.persistence.getBinding(binding.runtimeId)?.status).toBe('attached');

    const histWhileGateOff = recoveryOff
      .getHistorySource()
      .readPersistedNativeFeedHistory(registry.persistence, sess.id, 'agy');
    expect(histWhileGateOff.available).toBe(true);
    expect(histWhileGateOff.readOnly).toBe(true);
    expect(histWhileGateOff.events.length).toBeGreaterThanOrEqual(1);

    // Enable active reconcile and simulate startup recovery
    recoveryOff.setActiveReconcileEnabled(true);
    const startupRes = recoveryOff.reconcileOnDaemonStartup({
      sessionScopes: [{ sessionId: sess.id, instanceId: 'agy' }],
      trigger: 'daemon_startup',
    });
    expect(startupRes.skipped).toBe(false);
    expect(startupRes.reconciledBindings).toBe(1);
    expect(startupRes.emittedRecoveryEvents).toBe(1);
    expect(eventsSeen).toContain('native.recovery.changed');

    expect(registry.persistence.getBinding(binding.runtimeId)?.status).toBe('reconciling');
    expect(registry.persistence.getApprovalReceiptByApprovalId('appr_pending_1')?.state).toBe('connection_lost');
    expect(registry.persistence.getApprovalReceiptByApprovalId('appr_claimed_1')?.state).toBe('delivery_unknown');

    // Old client / feature-off projection returns Known Empty while DB history remains intact
    registry.setFeatureFlags({ enabled: false });
    const featureOffProj = registry.getProjectionForSession(sess.id, 'agy');
    expect(featureOffProj.enabled).toBe(false);
    expect(featureOffProj.activities).toHaveLength(0);
    expect(activeStore.listSessions({ includeArchived: true }).some((s) => s.id === sess.id)).toBe(true);

    // 1c. Newer schema in DB fails closed for native recovery while preserving legacy session list
    registry.setFeatureFlags({ enabled: true });
    activeStore
      .getDatabaseSync()
      .prepare('UPDATE component_schema_migrations SET version = 99 WHERE component = ?')
      .run(AGY_NATIVE_MIGRATION_COMPONENT);

    const newerStore = openStore(path.join(activeDir, 'active.sqlite'));
    const newerRegistry = new AgyNativeRuntimeRegistry(newerStore, { enabled: true });
    const newerRecovery = new AgyNativeRecoveryService({
      registry: newerRegistry,
      config: { activeReconcileEnabled: true },
    });
    const newerRes = newerRecovery.reconcileOnDaemonStartup({
      sessionScopes: [{ sessionId: sess.id, instanceId: 'agy' }],
    });
    expect(newerRes.skipped).toBe(true);
    expect(newerRes.reasonCode).toBe('native_schema_newer_than_reader');
    expect(newerRecovery.listCompatIncidents()[0]?.reasonCode).toBe('native_schema_newer_than_reader');
    expect(newerStore.getSession(sess.id)?.title).toBe('NP-15 Recovery Session');

    const newerHist = newerRecovery
      .getHistorySource()
      .readPersistedNativeFeedHistory(newerRegistry.persistence, sess.id, 'agy');
    expect(newerHist.available).toBe(false);
    expect(newerHist.reasonCode).toBe('native_schema_newer_than_reader');
  });

  // ── 2. Binding Guards, No Auto-Login & Hardened History Scanner (T15) ─

  it('Suite 2: enforces profile/source/revision/workspace/auth guards and hardened AGY history-scanner without WAL/SHM side effects', () => {
    const tmp = makeTempDir('np15-guard-');
    const store = openStore(path.join(tmp, 'guard.sqlite'));
    const wsDir = path.join(tmp, 'ws-a');
    fs.mkdirSync(wsDir, { recursive: true });
    const sess = seedSession(store, wsDir, { sessionId: 'sess_guard', instanceId: 'agy.work' });
    const registry = new AgyNativeRuntimeRegistry(store, { enabled: true });
    const stored = registry.ensureRuntimeBinding({
      sessionId: sess.id,
      instanceId: 'agy.work',
      profileRef: 'profile:work',
      sourceRef: 'agy_cli',
      status: 'reconciling',
    });
    const service = new AgyNativeRecoveryService({
      registry,
      config: { activeReconcileEnabled: true },
    });

    const baseGuard = {
      sessionId: sess.id,
      instanceId: 'agy.work',
      profileRef: 'profile:work',
      sourceRef: 'agy_cli',
      workspaceRoot: wsDir,
      authState: 'authenticated' as const,
      expectedBindingRevision: stored.bindingRevision,
      candidateNativeSessionId: '11111111-1111-4111-8111-111111111111',
      stored: { ...stored, workspaceRoot: wsDir },
    };

    expect(service.evaluateBindingGuard(baseGuard).allowed).toBe(true);

    // Mismatched profile
    const wrongProfile = service.evaluateBindingGuard({ ...baseGuard, profileRef: 'profile:personal' });
    expect(wrongProfile.allowed).toBe(false);
    expect(wrongProfile.reasonCode).toBe('profile_or_source_mismatch');

    // Mismatched source (App vs CLI)
    const wrongSource = service.evaluateBindingGuard({ ...baseGuard, sourceRef: 'agy_desktop' });
    expect(wrongSource.allowed).toBe(false);
    expect(wrongSource.reasonCode).toBe('profile_or_source_mismatch');

    // Mismatched binding revision
    const wrongRev = service.evaluateBindingGuard({ ...baseGuard, expectedBindingRevision: 99 });
    expect(wrongRev.allowed).toBe(false);
    expect(wrongRev.reasonCode).toBe('binding_revision_mismatch');

    // Mismatched workspace root
    const wrongWs = service.evaluateBindingGuard({
      ...baseGuard,
      workspaceRoot: path.join(tmp, 'ws-other'),
    });
    expect(wrongWs.allowed).toBe(false);
    expect(wrongWs.reasonCode).toBe('workspace_scope_mismatch');

    // Unauthenticated -> fails closed without triggering auto-login
    const unauth = service.evaluateBindingGuard({ ...baseGuard, authState: 'unauthenticated' });
    expect(unauth.allowed).toBe(false);
    expect(unauth.requiresManualAuth).toBe(true);
    expect(unauth.reasonCode).toBe('auth_required_manual_login');

    const uiSummary = service.buildRecoveryStatusSummary({
      sessionId: sess.id,
      instanceId: 'agy.work',
      authState: 'unauthenticated',
    });
    expect(uiSummary?.recoveryPhase).toBe('auth_required');
    expect(uiSummary?.autoLoginTriggered).toBe(false);

    // Hardened AGY history scanner: WAL DB without -wal/-shm produces ZERO new files on disk
    const agyRoot = path.join(tmp, 'agy-cli-root');
    const convId = '22222222-2222-4222-8222-222222222222';
    createFakeAgySummaryDb(agyRoot, convId, { walMode: true, dropWalShmAfterWrite: true });

    const filesBefore = fs.readdirSync(agyRoot).sort();
    expect(filesBefore).toEqual(['conversation_summaries.db']);

    const detailed = readAgyIndexedHistoryDetailedFromRoot(agyRoot, convId);
    expect(detailed.rootVerified).toBe(true);
    expect(detailed.messages).toHaveLength(2);
    expect(detailed.messages[0]?.text).toBe('Explain NP-15 recovery');
    expect(readAgyIndexedHistoryFromRoot(agyRoot, convId)).toHaveLength(2);

    const filesAfter = fs.readdirSync(agyRoot).sort();
    expect(filesAfter).toEqual(filesBefore); // ZERO -wal / -shm side-effect files created!

    // Bounded history truncation
    const bounded = readAgyIndexedHistoryDetailedFromRoot(agyRoot, convId, { maxMessages: 1 });
    expect(bounded.partial).toBe(true);
    expect(bounded.truncatedReason).toBe('max_messages');
    expect(bounded.messages).toHaveLength(1);

    // Traversal / reparse-point escape protection
    expect(readAgyIndexedHistoryDetailedFromRoot(agyRoot, '../escape').skippedReason).toBe(
      'invalid_session_id',
    );
    const outsideDir = path.join(tmp, 'outside-secret-root');
    createFakeAgySummaryDb(outsideDir, convId);
    const symlinkedRoot = path.join(tmp, 'symlinked-agy-root');
    fs.mkdirSync(symlinkedRoot, { recursive: true });
    // Create a junction/symlink inside symlinkedRoot pointing to outsideDir
    const junctionConversations = path.join(symlinkedRoot, 'conversations');
    fs.symlinkSync(outsideDir, junctionConversations, process.platform === 'win32' ? 'junction' : 'dir');
    const scanned = scanAgyRoot(symlinkedRoot, 'agy_cli', 10);
    expect(scanned).toHaveLength(0);
  });

  // ── 3. Same-Gen Replacement, Old-Gen Fencing, Out-of-Order & Controls ─

  it('Suite 3: fences same-gen replacement, old-gen stale frames, out-of-order attach, and gates workflow controls while reconciling', () => {
    const tmp = makeTempDir('np15-fence-');
    const store = openStore(path.join(tmp, 'fence.sqlite'));
    const wsDir = makeTempDir('np15-ws-fence-');
    const sess = seedSession(store, wsDir, { sessionId: 'sess_fence', instanceId: 'agy' });
    const registry = new AgyNativeRuntimeRegistry(store, { enabled: true });
    const service = new AgyNativeRecoveryService({
      registry,
      config: { activeReconcileEnabled: true },
    });
    const fixtures = loadNdjsonFixtures('v1-v2-negotiation-and-replay.ndjson');
    const v1Init = fixtures.get('win_1516_v1_handshake')!.initializeResult;

    const storedGen1 = registry.ensureRuntimeBinding({
      sessionId: sess.id,
      instanceId: 'agy',
      profileRef: 'agy:default',
      sourceRef: 'agy_cli',
      status: 'reconciling',
    });
    const bindingGen1: RuntimeBinding = {
      runtimeId: storedGen1.runtimeId,
      sessionId: sess.id,
      instanceId: 'agy',
      generation: storedGen1.generation,
    };

    // Start attach attempt #1 then attempt #2 (out-of-order attach simulation)
    const attempt1 = service.beginAttach({
      guard: {
        sessionId: sess.id,
        instanceId: 'agy',
        profileRef: 'agy:default',
        sourceRef: 'agy_cli',
        workspaceRoot: wsDir,
        authState: 'authenticated',
        candidateNativeSessionId: 'nat_1',
        stored: { ...storedGen1, workspaceRoot: wsDir },
      },
      initializeResult: v1Init,
    });
    const attempt2 = service.beginAttach({
      guard: {
        sessionId: sess.id,
        instanceId: 'agy',
        profileRef: 'agy:default',
        sourceRef: 'agy_cli',
        workspaceRoot: wsDir,
        authState: 'authenticated',
        candidateNativeSessionId: 'nat_1',
        stored: { ...storedGen1, workspaceRoot: wsDir },
      },
      initializeResult: v1Init,
    });
    expect(attempt2.attemptOrdinal).toBeGreaterThan(attempt1.attemptOrdinal);

    // Workflow control MUST be gated while reconciling
    expect(service.isWorkflowControlAllowed(bindingGen1).allowed).toBe(false);

    // Out-of-order attempt #1 must be discarded
    const lateComplete1 = service.completeAttach({
      binding: bindingGen1,
      connectionId: 'conn_1_stale',
      attemptOrdinal: attempt1.attemptOrdinal,
      nativeSessionId: 'nat_1',
      strategy: attempt1.strategy,
      compat: attempt1.negotiation.ok ? attempt1.negotiation.compat : evaluateCliVersionCompatibility('1.5.16'),
    });
    expect(lateComplete1.accepted).toBe(false);
    expect(lateComplete1.reasonCode).toBe('out_of_order_attach_discarded');

    // Attempt #2 succeeds on conn_1
    const okComplete2 = service.completeAttach({
      binding: bindingGen1,
      connectionId: 'conn_1',
      attemptOrdinal: attempt2.attemptOrdinal,
      nativeSessionId: 'nat_1',
      strategy: attempt2.strategy,
      compat: attempt2.negotiation.ok ? attempt2.negotiation.compat : evaluateCliVersionCompatibility('1.5.16'),
    });
    expect(okComplete2.accepted).toBe(true);
    expect(service.isWorkflowControlAllowed(bindingGen1, 'conn_1').allowed).toBe(true);

    // Same-generation replacement: conn_1 -> conn_2
    const attempt3 = service.beginAttach({
      guard: {
        sessionId: sess.id,
        instanceId: 'agy',
        profileRef: 'agy:default',
        sourceRef: 'agy_cli',
        workspaceRoot: wsDir,
        authState: 'authenticated',
        candidateNativeSessionId: 'nat_1',
        stored: { ...storedGen1, workspaceRoot: wsDir },
      },
      initializeResult: v1Init,
    });
    const okComplete3 = service.completeAttach({
      binding: bindingGen1,
      connectionId: 'conn_2',
      attemptOrdinal: attempt3.attemptOrdinal,
      nativeSessionId: 'nat_1',
      strategy: attempt3.strategy,
      compat: attempt3.negotiation.ok ? attempt3.negotiation.compat : evaluateCliVersionCompatibility('1.5.16'),
    });
    expect(okComplete3.accepted).toBe(true);
    expect(okComplete3.replacedConnectionId).toBe('conn_1');

    // Late frame / response from retired conn_1 is fenced; conn_2 remains accepted
    expect(
      service.acceptLiveIngressCheck({
        binding: bindingGen1,
        connectionId: 'conn_1',
        ingressOrdinal: 99,
        channel: 'live',
        wire: {},
      }),
    ).toEqual({ accepted: false, reasonCode: 'connection_replaced_same_generation' });
    expect(
      service.acceptLiveIngressCheck({
        binding: bindingGen1,
        connectionId: 'conn_2',
        ingressOrdinal: 1,
        channel: 'live',
        wire: {},
      }),
    ).toEqual({ accepted: true });

    // Create an approval on new conn_2 and verify late close from conn_1 does NOT invalidate conn_2!
    registry.persistence.createPendingApprovalReceipt({ binding: bindingGen1, approvalId: 'appr_conn2' });
    const staleCloseRes = service.handleTransportLost({
      binding: bindingGen1,
      connectionId: 'conn_1',
      trigger: 'process_crash',
    });
    expect(staleCloseRes.applied).toBe(false);
    expect(staleCloseRes.ignoredStaleConnection).toBe(true);
    expect(registry.persistence.getApprovalReceiptByApprovalId('appr_conn2')?.state).toBe('pending');

    // Advance generation gen_1 -> gen_2
    const storedGen2 = registry.advanceRuntimeGeneration(bindingGen1.runtimeId, {
      generation: asBindingGeneration('gen_2'),
      status: 'reconciling',
    });
    const bindingGen2: RuntimeBinding = {
      ...bindingGen1,
      generation: storedGen2.generation,
    };

    // Old gen_1 frames & attach attempts are fenced
    expect(
      service.acceptLiveIngressCheck({
        binding: bindingGen1,
        connectionId: 'conn_2',
        ingressOrdinal: 2,
        channel: 'live',
        wire: {},
      }),
    ).toEqual({ accepted: false, reasonCode: 'generation_retired' });

    const attempt4 = service.beginAttach({
      guard: {
        sessionId: sess.id,
        instanceId: 'agy',
        profileRef: 'agy:default',
        sourceRef: 'agy_cli',
        workspaceRoot: wsDir,
        authState: 'authenticated',
        candidateNativeSessionId: 'nat_1',
        stored: { ...storedGen2, workspaceRoot: wsDir },
      },
      initializeResult: v1Init,
    });
    const okGen2 = service.completeAttach({
      binding: bindingGen2,
      connectionId: 'conn_3',
      attemptOrdinal: attempt4.attemptOrdinal,
      nativeSessionId: 'nat_1',
      strategy: attempt4.strategy,
      compat: attempt4.negotiation.ok ? attempt4.negotiation.compat : evaluateCliVersionCompatibility('1.5.16'),
    });
    expect(okGen2.accepted).toBe(true);
    expect(okGen2.invalidatedGenerations).toEqual([bindingGen1.generation]);

    const scheduleObservation = {
      scheduleNativeId: 'nightly', occurrenceId: 'first', state: 'finished',
      source: 'live_protocol', observedAt: 1, wireVariant: 'acp-v1', ingressOrdinal: 1,
    } as const;
    const schedule = {
      binding: bindingGen2, nowMs: 2, persistedOccurrences: [{
        scheduleNativeId: 'nightly', occurrenceId: 'first', workflowId: asWorkflowId('wf_nightly'),
        workId: asWorkId('work_first'), originGeneration: bindingGen1.generation, lastState: 'queued',
      }],
    } as const;
    expect(service.reconcileScheduleOccurrences({ ...schedule, freshEvidence: [
      { ...scheduleObservation, connectionId: 'conn_2' }, scheduleObservation,
    ] }).occurrences[0]?.status).toBe('stale_unverified');
    expect(service.reconcileScheduleOccurrences({ ...schedule, freshEvidence: [
      { ...scheduleObservation, connectionId: 'conn_3' },
    ] }).occurrences[0]?.status).toBe('fired_observed');

    // Simulate network disconnect & frontend cursor resync across generation boundary
    const claimedRes = registry.persistence.createPendingApprovalReceipt({
      binding: bindingGen2,
      approvalId: 'appr_gen2_claimed',
    });
    expect(claimedRes.state).toBe('pending');
    registry.persistence.claimApprovalReceiptCas({
      approvalId: 'appr_gen2_claimed',
      expectedGeneration: bindingGen2.generation,
    });

    const netLost = service.handleTransportLost({
      binding: bindingGen2,
      connectionId: 'conn_3',
      trigger: 'network_disconnect',
      knownApprovalIds: ['appr_gen2_claimed'],
    });
    expect(netLost.applied).toBe(true);
    expect(netLost.status).toBe('reconciling');
    expect(netLost.deliveryUnknownReceipts).toBe(1);

    // Frontend with old gen_1 cursor receives RESYNC_REQUIRED -> re-reads snapshot + new cursor
    const staleCursorRead = registry.readEventsForSession(sess.id, 'agy', {
      afterSeq: 0,
      limit: 50,
      expectedGeneration: bindingGen1.generation,
    });
    expect(staleCursorRead.resyncRequired).toBe(true);
    if (staleCursorRead.resyncRequired) {
      expect(staleCursorRead.reason).toBe('generation_changed');
    }
    const freshFeed = service
      .getHistorySource()
      .readPersistedNativeFeedHistory(registry.persistence, sess.id, 'agy');
    expect(freshFeed.available).toBe(true);
    expect(freshFeed.resyncRequired).toBe(false);
    expect(freshFeed.projection?.binding.generation).toBe(bindingGen2.generation);
  });

  // ── 4. Independent History Replay Isolation & Native Job Continuation ─

  it('Suite 4: isolates history_replay approvals/leases and refuses unverified cross-process daemon survival', () => {
    const tmp = makeTempDir('np15-replay-');
    const store = openStore(path.join(tmp, 'replay.sqlite'));
    const registry = new AgyNativeRuntimeRegistry(store, { enabled: true });
    const service = new AgyNativeRecoveryService({
      registry,
      config: { activeReconcileEnabled: true },
    });
    const tFixtures = loadNdjsonFixtures('t09-t14-recovery-scenarios.ndjson');
    const replayScenario = tFixtures.get('t14_load_replay_with_blocked_approval')!;

    const binding: RuntimeBinding = {
      runtimeId: asActivityId('nrt_rpl') as unknown as RuntimeBinding['runtimeId'],
      sessionId: 'sess_rpl',
      instanceId: 'agy',
      generation: asBindingGeneration('gen_rpl'),
    };

    const sanitized = service.getHistorySource().sanitizeHistoryReplayFrames({
      captureId: 'cap_t14',
      expectedBinding: binding,
      frames: replayScenario.frames.map((f: any) => ({
        binding,
        connectionId: 'conn_replay',
        ingressOrdinal: f.ingressOrdinal,
        channel: f.channel,
        wire: f.wire,
      })),
    });

    expect(sanitized.createsLiveLeases).toBe(false);
    expect(sanitized.emitsLiveApprovals).toBe(false);
    expect(sanitized.blockedServerRequestCount).toBe(1);
    expect(sanitized.blockedServerRequests[0]).toMatchObject({
      ingressOrdinal: 2,
      rpcId: 8101,
      method: 'session/request_permission',
      reasonCode: 'replay_server_request_blocked',
    });
    expect(sanitized.entries).toHaveLength(3);
    expect(sanitized.entries.every((e) => e.evidence.kind === 'replay')).toBe(true);

    // Native job continuation: daemon/finite without fresh evidence stays stale_needs_evidence
    const now = 1_764_000_500_000;
    const daemonWorkId = asWorkId('wrk_daemon_old');
    const finiteWorkId = asWorkId('wrk_finite_verified');
    const priorWorks: NativeWork[] = [
      {
        id: daemonWorkId,
        kind: 'daemon',
        blocking: 'detached',
        state: {
          kind: 'known',
          value: 'running',
          evidence: {
            kind: 'live_protocol',
            connectionId: 'dead_conn',
            ingressOrdinal: 3,
            wireVariant: 'agy-acp-v1',
            observedAt: now - 30_000,
          },
        },
        revision: 1,
      },
      {
        id: finiteWorkId,
        kind: 'finite_command',
        blocking: 'confirmed_blocking',
        state: {
          kind: 'known',
          value: 'running',
          evidence: {
            kind: 'live_protocol',
            connectionId: 'dead_conn',
            ingressOrdinal: 4,
            wireVariant: 'agy-acp-v1',
            observedAt: now - 30_000,
          },
        },
        revision: 2,
      },
    ];

    const freshMap = new Map<NativeWork['id'], NonNullable<Parameters<typeof service.evaluateNativeJobContinuation>[0]['freshEvidenceByWorkId'] extends ReadonlyMap<any, infer V> ? V : never>>();
    freshMap.set(finiteWorkId, {
      kind: 'native_snapshot',
      sourceId: 'tasks_snapshot',
      schemaVersion: '1',
      observedAt: now - 1_000,
      staleAt: now + 30_000,
    });

    const evalRes = service.evaluateNativeJobContinuation({
      priorWorks,
      freshEvidenceByWorkId: freshMap,
      hasLiveConnection: false,
      nowMs: now,
    });
    expect(evalRes.find((j) => j.workId === daemonWorkId)).toMatchObject({
      continuationState: 'stale_needs_evidence',
      evidenceSource: 'prior_generation_only',
      reasonCode: 'no_live_continuation_evidence',
    });
    expect(evalRes.find((j) => j.workId === finiteWorkId)).toMatchObject({
      continuationState: 'confirmed_continuable',
      evidenceSource: 'native_snapshot',
    });
  });

  // ── 5. NP-12 Schedule & Occurrence Recovery Interop (T09) ────────────

  it('Suite 5: reconciles NP-12 schedule occurrences with cross-gen dedupe and honest unverified fallback (T09)', () => {
    const tmp = makeTempDir('np15-sched-');
    const store = openStore(path.join(tmp, 'sched.sqlite'));
    const registry = new AgyNativeRuntimeRegistry(store, { enabled: true });
    const service = new AgyNativeRecoveryService({
      registry,
      config: { activeReconcileEnabled: true },
    });

    const binding: RuntimeBinding = {
      runtimeId: asActivityId('nrt_sched') as unknown as RuntimeBinding['runtimeId'],
      sessionId: 'sess_sched',
      instanceId: 'agy',
      generation: asBindingGeneration('gen_2'),
    };
    const wfId = asWorkflowId('wf_sched_1');
    const now = 1_764_001_000_000;

    const reconciled = service.reconcileScheduleOccurrences({
      binding,
      nowMs: now,
      persistedOccurrences: [
        // Duplicate occurrence across gen_1 and gen_2 -> must deduplicate
        {
          workflowId: wfId,
          scheduleNativeId: 'sched_nightly',
          occurrenceId: 'occ_1',
          workId: asWorkId('wrk_occ_1_old'),
          originGeneration: asBindingGeneration('gen_1'),
          lastState: 'queued',
          lastObservedAt: now - 10_000,
        },
        {
          workflowId: wfId,
          scheduleNativeId: 'sched_nightly',
          occurrenceId: 'occ_1',
          workId: asWorkId('wrk_occ_1_new'),
          originGeneration: asBindingGeneration('gen_2'),
          lastState: 'running',
          lastObservedAt: now - 2_000,
        },
        // Independent second occurrence with NO fresh evidence after restart
        {
          workflowId: wfId,
          scheduleNativeId: 'sched_nightly',
          occurrenceId: 'occ_2',
          workId: asWorkId('wrk_occ_2'),
          originGeneration: asBindingGeneration('gen_1'),
          lastState: 'queued',
          lastObservedAt: now - 15_000,
        },
      ],
      freshEvidence: [
        {
          scheduleNativeId: 'sched_nightly',
          occurrenceId: 'occ_1',
          state: 'finished',
          source: 'native_snapshot',
          observedAt: now - 500,
          sourceId: 'schedule_data',
          schemaVersion: '1',
          staleAt: now + 10_000,
          nextAt: now + 3_600_000,
        },
      ],
    });

    expect(reconciled.deduplicatedCount).toBe(1);
    expect(reconciled.unverifiedCount).toBe(1);
    expect(reconciled.occurrences).toHaveLength(2);

    const occ1 = reconciled.occurrences.find((o) => o.occurrenceId === 'occ_1')!;
    expect(occ1.workId).toBe(asWorkId('wrk_occ_1_new'));
    expect(occ1.status).toBe('fired_observed');
    expect(occ1.observedState.kind).toBe('known');
    expect(occ1.statusSource).toBe('native_snapshot');

    const occ2 = reconciled.occurrences.find((o) => o.occurrenceId === 'occ_2')!;
    expect(occ2.status).toBe('stale_unverified');
    expect(occ2.deduplicatedAcrossGenerations).toBe(true);
    expect(occ2.statusSource).toBe('prior_generation_only');
    expect(occ2.observedState).toEqual({
      kind: 'stale',
      last: 'queued',
      reasonCode: 'schedule_occurrence_unverified',
    });
    expect(reconciled.nextAt).toMatchObject({ kind: 'known', value: now + 3_600_000 });
  });

  // ── 6. ACP v1 Default, Controlled v2 Preview & Negative Cases (T15) ──

  it('Suite 6: defaults to ACP v1, downgrades v2->v1 before prompt, gates v2 preview codec, and fails closed on negative frames', () => {
    const fixtures = loadNdjsonFixtures('v1-v2-negotiation-and-replay.ndjson');

    // Default initialize request is strictly protocolVersion 1
    expect(buildInitializeRequest().protocolVersion).toBe(1);
    expect(buildInitializeRequest({ allowV2Preview: true }).protocolVersion).toBe(2);

    // Real Windows 1.5.16 & 1.5.17 handshake parsing + v2 -> v1 downgrade
    const win1516 = negotiateAcpProtocol({
      requestedProtocol: 1,
      allowV2Preview: false,
      initializeResult: fixtures.get('win_1516_v1_handshake')!.initializeResult,
    });
    expect(win1516.ok).toBe(true);
    if (win1516.ok) {
      expect(win1516.capabilities.negotiatedProtocol).toBe(1);
      expect(win1516.capabilities.sessionCapabilities.resume).toBe(true);
      expect(win1516.capabilities.sessionCapabilities.close).toBe(true);
      expect(win1516.instantiateV2Preview).toBe(false);
      expect(createAcpV2PreviewCodec({ allowV2Preview: false, negotiated: win1516.capabilities })).toBeNull();
    }

    const win1517Downgrade = negotiateAcpProtocol({
      requestedProtocol: 2,
      allowV2Preview: true,
      initializeResult: fixtures.get('win_1517_v2_downgrade_to_v1')!.initializeResult,
    });
    expect(win1517Downgrade.ok).toBe(true);
    if (win1517Downgrade.ok) {
      expect(win1517Downgrade.capabilities.downgradedFromV2).toBe(true);
      expect(win1517Downgrade.capabilities.negotiatedProtocol).toBe(1);
      expect(win1517Downgrade.reasonCode).toBe('v2_downgraded_to_v1');
      expect(win1517Downgrade.instantiateV2Preview).toBe(false);
      expect(
        createAcpV2PreviewCodec({ allowV2Preview: true, negotiated: win1517Downgrade.capabilities }),
      ).toBeNull();

      // Separate v1 resume vs v1 load selection
      const v1Resume = selectAttachStrategy({
        negotiated: win1517Downgrade.capabilities,
        compat: win1517Downgrade.compat,
        hasNativeSessionId: true,
        guard: { allowed: true, requiresManualAttach: false, requiresManualAuth: false },
        allowV2Preview: true,
      });
      expect(v1Resume.mode).toBe('v1_resume');
      expect(v1Resume.willReplayHistory).toBe(false);

      const v1LoadOnly = selectAttachStrategy({
        negotiated: {
          ...win1517Downgrade.capabilities,
          sessionCapabilities: {
            ...win1517Downgrade.capabilities.sessionCapabilities,
            resume: false,
          },
        },
        compat: win1517Downgrade.compat,
        hasNativeSessionId: true,
        guard: { allowed: true, requiresManualAttach: false, requiresManualAuth: false },
        allowV2Preview: true,
      });
      expect(v1LoadOnly.mode).toBe('v1_load_replay');
      expect(v1LoadOnly.willReplayHistory).toBe(true);
      expect(v1LoadOnly.channelDuringAttach).toBe('history_replay');
    }

    // Negative: unknown protocol 99 & v2 without schema confirmation fail closed
    const neg99 = negotiateAcpProtocol({
      requestedProtocol: 1,
      allowV2Preview: false,
      initializeResult: fixtures.get('negative_unknown_protocol_99')!.initializeResult,
    });
    expect(neg99.ok).toBe(false);
    if (!neg99.ok) expect(neg99.reasonCode).toBe('unsupported_protocol_version');

    const negUnconfirmed = negotiateAcpProtocol({
      requestedProtocol: 2,
      allowV2Preview: true,
      initializeResult: fixtures.get('negative_v2_without_schema_confirmation')!.initializeResult,
    });
    expect(negUnconfirmed.ok).toBe(false);
    if (!negUnconfirmed.ok) expect(negUnconfirmed.reasonCode).toBe('v2_schema_unconfirmed');

    // Negative: v1 codec rejects v2-only frames & preserves typed RpcId (number vs string)
    const v1Codec = new AcpV1ProtocolCodec();
    expect(v1Codec.decodeFrame(fixtures.get('negative_v2_frame_on_v1_wire')!.frame)).toEqual({
      kind: 'v2_frame_rejected_on_v1',
      reasonCode: 'unsupported_protocol_version',
      methodOrUpdate: 'state_update',
    });
    const numReq = v1Codec.decodeFrame({ jsonrpc: '2.0', id: 9001, method: 'session/request_permission', params: {} });
    const strReq = v1Codec.decodeFrame({ jsonrpc: '2.0', id: '9001', method: 'session/request_permission', params: {} });
    expect(numReq).toMatchObject({ kind: 'v1_server_request', rpcId: 9001, rpcIdType: 'number' });
    expect(strReq).toMatchObject({ kind: 'v1_server_request', rpcId: '9001', rpcIdType: 'string' });

    // Controlled v2 preview codec instantiation + replay boundary + replay_complete transition
    const v2Neg = negotiateAcpProtocol({
      requestedProtocol: 2,
      allowV2Preview: true,
      initializeResult: fixtures.get('synthetic_v2_preview_confirmed')!.initializeResult,
    });
    expect(v2Neg.ok).toBe(true);
    if (v2Neg.ok) {
      expect(createAcpV2PreviewCodec({ allowV2Preview: false, negotiated: v2Neg.capabilities })).toBeNull();
      const v2Codec = createAcpV2PreviewCodec({ allowV2Preview: true, negotiated: v2Neg.capabilities })!;
      expect(v2Codec).not.toBeNull();
      const resumeRpc = v2Codec.encodeSessionResume({
        sessionId: 'nat_v2_1',
        cwd: 'D:\\work',
        replayFrom: 'cur_00',
      });
      expect(resumeRpc.params.replayFrom).toBe('cur_00');
      expect(v2Codec.isReplayActive()).toBe(true);

      const frames = fixtures.get('v2_replay_sequence')!.frames as unknown[];
      expect(v2Codec.decodeFrame(frames[0])).toMatchObject({
        kind: 'v2_session_message',
        channel: 'history_replay',
        cursor: 'cur_01',
      });
      // Server request during replay MUST be blocked
      expect(v2Codec.decodeFrame(frames[1])).toMatchObject({
        kind: 'v2_server_request_blocked_replay',
        reasonCode: 'replay_server_request_blocked',
      });
      expect(v2Codec.decodeFrame(frames[2])).toMatchObject({
        kind: 'v2_state_update',
        state: 'reconciling',
        channel: 'history_replay',
      });
      // replay_complete flips channel to live
      expect(v2Codec.decodeFrame(frames[3])).toMatchObject({
        kind: 'v2_replay_complete',
        finalCursor: 'cur_02',
        channelTransitionedToLive: true,
      });
      expect(v2Codec.isReplayActive()).toBe(false);
      // Duplicate replay_complete rejected
      expect(v2Codec.decodeFrame(frames[3])).toMatchObject({
        kind: 'v2_invalid_frame',
        reason: 'duplicate_replay_complete',
      });
      // Post-replay server request & prompt_accepted allowed on live channel
      expect(v2Codec.decodeFrame(frames[4])).toMatchObject({
        kind: 'v2_server_request_live',
        rpcId: 'req_live_402',
        rpcIdType: 'string',
      });
      expect(v2Codec.decodeFrame(frames[5])).toMatchObject({
        kind: 'v2_prompt_accepted',
        rpcId: 7001,
        rpcIdType: 'number',
        turnToken: 'turn_tok_7001',
      });
      expect(v2Codec.decodeFrame(frames[6])).toMatchObject({
        kind: 'v2_state_update',
        state: 'running',
        channel: 'live',
      });
    }
  });

  // ── 7. Per-Version Cancel, Close, Windows Tree & Bad Version Degrade ──

  it('Suite 7: executes per-version cancel/close, Windows taskkill tree fallback, ownership guard, and bad-version degradation', async () => {
    const coordinator = new AgyProcessTreeTeardownCoordinator({
      cancelGraceMs: 20,
      closeGraceMs: 20,
      pollIntervalMs: 5,
    });
    const binding: RuntimeBinding = {
      runtimeId: asActivityId('nrt_tree') as unknown as RuntimeBinding['runtimeId'],
      sessionId: 'sess_tree',
      instanceId: 'agy',
      generation: asBindingGeneration('gen_tree'),
    };
    const fixtures = loadNdjsonFixtures('v1-v2-negotiation-and-replay.ndjson');
    const v1Negotiated = negotiateAcpProtocol({
      requestedProtocol: 1,
      allowV2Preview: false,
      initializeResult: fixtures.get('win_1516_v1_handshake')!.initializeResult,
    });
    if (!v1Negotiated.ok) throw new Error('expected valid v1 handshake');

    const makeMockTransport = (exitOn: 'cancel' | 'close' | 'tree'): { transport: TeardownTransport; calls: string[] } => {
      let alive = true;
      let tick = 0;
      const calls: string[] = [];
      return {
        calls,
        transport: {
          sendCancel: async () => {
            calls.push('cancel');
            if (exitOn === 'cancel') alive = false;
            return true;
          },
          sendSessionClose: async () => {
            calls.push('close');
            if (exitOn === 'close') alive = false;
            return true;
          },
          isProcessAlive: () => alive,
          killProcessTree: async (_pid, platform) => {
            calls.push(`kill:${platform}`);
            alive = false;
            return {
              ok: true,
              method: platform === 'win32' ? 'taskkill_tree' : 'posix_pgroup',
            };
          },
          wait: async (ms) => {
            tick += ms;
          },
          now: () => tick,
        },
      };
    };

    // 7a. Unowned PID must be refused
    const unowned = makeMockTransport('tree');
    const refused = await coordinator.teardownConnection({
      binding,
      connectionId: 'conn_tree',
      nativeSessionId: 'nat_tree',
      pid: 99999,
      hasActiveTurnOrWork: true,
      negotiated: v1Negotiated.capabilities,
      compat: evaluateCliVersionCompatibility('1.5.16'),
      transport: unowned.transport,
      platform: 'win32',
    });
    expect(refused.refusedNotOwned).toBe(true);
    expect(unowned.calls).toHaveLength(0);

    const originalOwner = {
      pid: 1000, binding, connectionId: 'conn_tree', cliVersion: '1.5.16',
      platform: 'win32', spawnedAt: 1000,
    } as const;
    const replacement = { ...originalOwner, connectionId: 'replacement', spawnedAt: 2000 };
    const reused = makeMockTransport('tree');
    coordinator.registerOwnedProcess(originalOwner);
    const interrupted = await coordinator.teardownConnection({
      binding, connectionId: originalOwner.connectionId, pid: originalOwner.pid,
      nativeSessionId: 'nat_tree', hasActiveTurnOrWork: true, platform: 'win32',
      negotiated: v1Negotiated.capabilities, compat: evaluateCliVersionCompatibility('1.5.16'),
      transport: { ...reused.transport, sendCancel: async () => {
        coordinator.registerOwnedProcess(replacement);
        return true;
      } },
    });
    expect(interrupted.refusedNotOwned).toBe(true);
    expect(reused.calls).toHaveLength(0);
    expect(coordinator.getOwnedProcess(originalOwner.pid)).toBe(replacement);

    // 7b. 1.5.16 with clean session/close exit skips taskkill
    coordinator.registerOwnedProcess({
      pid: 1016,
      binding,
      connectionId: 'conn_tree',
      cliVersion: '1.5.16',
      platform: 'win32',
      spawnedAt: 1000,
    });
    const t1516 = makeMockTransport('close');
    const r1516 = await coordinator.teardownConnection({
      binding,
      connectionId: 'conn_tree',
      nativeSessionId: 'nat_tree',
      pid: 1016,
      hasActiveTurnOrWork: true,
      negotiated: v1Negotiated.capabilities,
      compat: evaluateCliVersionCompatibility('1.5.16'),
      transport: t1516.transport,
      platform: 'win32',
    });
    expect(r1516.cancelSent).toBe(true);
    expect(r1516.closeSent).toBe(true);
    expect(r1516.treeKillInvoked).toBe(false);
    expect(r1516.exitedCleanly).toBe(true);

    // 7c. 1.5.14 skips session/close and falls back to Windows taskkill_tree
    coordinator.registerOwnedProcess({
      pid: 1014,
      binding,
      connectionId: 'conn_tree',
      cliVersion: '1.5.14',
      platform: 'win32',
      spawnedAt: 1000,
    });
    const t1514 = makeMockTransport('tree');
    const r1514 = await coordinator.teardownConnection({
      binding,
      connectionId: 'conn_tree',
      nativeSessionId: 'nat_tree',
      pid: 1014,
      hasActiveTurnOrWork: true,
      negotiated: v1Negotiated.capabilities,
      compat: evaluateCliVersionCompatibility('1.5.14'),
      transport: t1514.transport,
      platform: 'win32',
    });
    expect(r1514.cancelSent).toBe(true);
    expect(r1514.closeSent).toBe(false);
    expect(r1514.closeSkippedReason).toBe('cli_version_predates_reliable_close');
    expect(r1514.treeKillInvoked).toBe(true);
    expect(r1514.treeKillMethod).toBe('taskkill_tree');
    expect(r1514.exitedCleanly).toBe(true);

    // 7d. Quarantined bad version degrades, skips cancel/close, kills HM-owned tree
    coordinator.registerOwnedProcess({
      pid: 1013,
      binding,
      connectionId: 'conn_tree',
      cliVersion: '1.5.13-bad',
      platform: 'win32',
      spawnedAt: 1000,
    });
    const badCompat = evaluateCliVersionCompatibility('1.5.13-bad', ['1.5.13-bad']);
    expect(badCompat.degradedToSafeMode).toBe(true);
    const tBad = makeMockTransport('tree');
    const rBad = await coordinator.teardownConnection({
      binding,
      connectionId: 'conn_tree',
      nativeSessionId: 'nat_tree',
      pid: 1013,
      hasActiveTurnOrWork: true,
      negotiated: v1Negotiated.capabilities,
      compat: badCompat,
      transport: tBad.transport,
      platform: 'win32',
    });
    expect(rBad.cancelSent).toBe(false);
    expect(rBad.closeSent).toBe(false);
    expect(rBad.closeSkippedReason).toBe('bad_cli_version_degraded');
    expect(rBad.treeKillMethod).toBe('taskkill_tree');
  });

  // ── 8. UI Selector Summary & Context Handoff / Legacy Regression ─────

  it('Suite 8: produces NP-03 UI recovery summary and keeps Context Handoff watermark untouched', async () => {
    const tmp = makeTempDir('np15-handoff-');
    const store = openStore(path.join(tmp, 'handoff.sqlite'));
    const wsDir = makeTempDir('np15-ws-ho-');
    const sess = seedSession(store, wsDir, { sessionId: 'sess_ho', instanceId: 'agy' });

    // Record one legacy HM turn and a Codex handoff binding at seq 3
    const t1Seq = store.appendEvent(sess.id, 'message.user', { harnessId: 'agy', text: 'Init' }, 't1', 1000).seq;
    const t2Seq = store.appendEvent(sess.id, 'message.assistant.completed', { harnessId: 'agy', text: 'Done' }, 't1', 1001).seq;
    const t3Seq = store.appendEvent(sess.id, 'turn.completed', { harnessId: 'agy', stopReason: 'end_turn' }, 't1', 1002).seq;
    expect(t1Seq).toBeLessThan(t2Seq);
    store.upsertSessionBinding({
      sessionId: sess.id,
      harnessId: 'codex',
      harnessKind: 'codex',
      nativeSessionId: 'codex_thr_1',
      syncedUpToSeq: t3Seq,
      driverUsed: 'codex_inject_items',
      updatedAt: 1005,
    });

    const registry = new AgyNativeRuntimeRegistry(store, { enabled: true });
    const stored = registry.ensureRuntimeBinding({
      sessionId: sess.id,
      instanceId: 'agy',
      profileRef: 'agy:default',
      sourceRef: 'agy_cli',
      status: 'attached',
    });
    const service = new AgyNativeRecoveryService({
      registry,
      config: { activeReconcileEnabled: true },
    });
    service.reconcileOnDaemonStartup({
      sessionScopes: [{ sessionId: sess.id, instanceId: 'agy' }],
      trigger: 'windows_reboot',
    });

    // Native recovery events MUST NOT advance HM session lastSeq or Codex syncedUpToSeq!
    expect(store.getSession(sess.id)?.lastSeq).toBe(t3Seq);
    expect(store.getSessionBinding(sess.id, 'codex')?.syncedUpToSeq).toBe(t3Seq);

    const summary = service.buildRecoveryStatusSummary({
      sessionId: sess.id,
      instanceId: 'agy',
      indexedHistoryAvailable: true,
    });
    expect(summary).not.toBeNull();
    expect(summary?.recoveryPhase).toBe('reconciling');
    expect(summary?.historyReadPathAvailable).toBe(true);
    expect(summary?.autoLoginTriggered).toBe(false);
    expect(summary?.lastSeenAt).toBeTypeOf('number');

    // ContextCompiler still reads only HM turn watermark cleanly
    const ledger = new TaskLedgerService(store, () => undefined);
    const compiler = new ContextCompiler(
      store,
      ledger,
      { budgetTokens: 8_000, autoAttach: true },
      () => undefined,
      new PluginEvents(() => {}),
    );
    const packet = await compiler.compile({
      session: store.getSession(sess.id)!,
      targetHarnessId: 'codex',
      targetHarnessKind: 'codex',
      binding: store.getSessionBinding(sess.id, 'codex'),
    });
    expect(packet.preview.syncedUpToSeq).toBe(t3Seq);
    expect(packet.preview.unsyncedTurnCount).toBe(0);
    expect(AGY_NATIVE_CONTRACT_VERSION).toBe(1);
    expect(AGY_NATIVE_CONTRACT_REVISION).toBe('agy-native-v1.0.0');
  });
});
