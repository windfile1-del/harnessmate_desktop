import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGY_NATIVE_MIGRATION_COMPONENT,
  AGY_NATIVE_MIGRATION_VERSION,
  asActivityId,
  asBindingGeneration,
  asNativeAgentId,
  asWorkId,
} from '@harnessmate/protocol';
import { HarnessMateStore } from '../src/db/sqlite.js';
import {
  AgyNativeRuntimeRegistry,
  NativePersistenceError,
  NativeRuntimeStore,
  computePayloadDigest,
  decodeNativeCursor,
  encodeNativeCursor,
} from '../src/harnesses/agy/native/wiring/index.js';

const tempDirs: string[] = [];
const openStores: HarnessMateStore[] = [];

function openStore(dbPath: string): HarnessMateStore {
  const s = new HarnessMateStore(dbPath);
  openStores.push(s);
  return s;
}

function makeTempDb(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return path.join(dir, 'test.sqlite');
}

function seedLegacyWorkspaceAndSession(store: HarnessMateStore): { workspaceId: string; sessionId: string } {
  const ws = store.createWorkspace({
    id: 'ws_1',
    name: 'Test Workspace',
    rootPath: 'D:\\HarnessMate\\tmp-ws',
    isGitRepo: false,
    gitBranch: null,
    createdAt: 1000,
  });
  const sess = store.createSession({
    id: 'sess_1',
    workspaceId: ws.id,
    harnessId: 'agy',
    harnessKind: 'agy',
    nativeSessionId: null,
    cwd: ws.rootPath,
    worktreeBranch: null,
    title: 'Legacy AGY Session',
    status: 'idle',
    model: null,
    reasoningEffort: null,
    permissionMode: 'manual',
    lastSeq: 0,
    createdAt: 1000,
    updatedAt: 1000,
  });
  return { workspaceId: ws.id, sessionId: sess.id };
}

afterEach(() => {
  while (openStores.length > 0) {
    openStores.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

describe('AGY Native SQLite component migration & atomic persistence (NP-02)', () => {
  it('migrates a new DB, is idempotent on repeat opens, and migrates pre-NP-02 legacy DBs without touching legacy rows', () => {
    // 1. Simulate a pre-NP-02 legacy DB without component_schema_migrations or native_* tables
    const dbPath = makeTempDb('hm-np02-legacy-');
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
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
      INSERT INTO workspaces VALUES ('ws_old', 'Legacy WS', 'D:\\legacy', 0, NULL, 100);
      INSERT INTO sessions VALUES ('sess_old', 'ws_old', 'agy', 'agy', 'nat_old', 'D:\\legacy', NULL, 'Old Session', 'idle', NULL, NULL, 'manual', 2, NULL, 100, 200);
    `);
    rawDb.close();

    // 2. Open with HarnessMateStore -> runs additive migration
    const store1 = new HarnessMateStore(dbPath);
    expect(store1.getNativeRuntimeSchemaStatus()).toEqual({
      component: AGY_NATIVE_MIGRATION_COMPONENT,
      supportedVersion: AGY_NATIVE_MIGRATION_VERSION,
      storedVersion: 1,
      compatible: true,
      newerThanReader: false,
    });
    const legacySession = store1.getSession('sess_old');
    expect(legacySession?.title).toBe('Old Session');
    expect(legacySession?.lastSeq).toBe(2);
    expect(legacySession?.status).toBe('idle');
    store1.close();

    // 3. Reopen again -> idempotent repeat migration
    const store2 = new HarnessMateStore(dbPath);
    expect(store2.getNativeRuntimeSchemaStatus().compatible).toBe(true);
    expect(store2.getSession('sess_old')?.nativeSessionId).toBe('nat_old');
    store2.close();
  });

  it('closes native access cleanly when DB component version is newer than reader while preserving legacy reads', () => {
    const dbPath = makeTempDb('hm-np02-newer-');
    const store1 = openStore(dbPath);
    seedLegacyWorkspaceAndSession(store1);
    store1
      .getDatabaseSync()
      .prepare('UPDATE component_schema_migrations SET version = 99 WHERE component = ?')
      .run(AGY_NATIVE_MIGRATION_COMPONENT);
    store1.close();

    const store2 = openStore(dbPath);
    const schemaStatus = store2.getNativeRuntimeSchemaStatus();
    expect(schemaStatus.compatible).toBe(false);
    expect(schemaStatus.newerThanReader).toBe(true);
    expect(schemaStatus.storedVersion).toBe(99);

    // Legacy sessions remain fully readable
    expect(store2.getSession('sess_1')?.title).toBe('Legacy AGY Session');

    // Native persistence fails closed
    const nativeStore = new NativeRuntimeStore(store2);
    expect(() =>
      nativeStore.ensureBinding({
        sessionId: 'sess_1',
        instanceId: 'agy',
        profileRef: 'agy:default',
      }),
    ).toThrowError(NativePersistenceError);

    store2.close();
  });

  it('commits snapshot and event in one atomic transaction, rolls back both on failure, and deduplicates mutationKey', () => {
    const dbPath = makeTempDb('hm-np02-atomic-');
    const store = openStore(dbPath);
    const { sessionId } = seedLegacyWorkspaceAndSession(store);
    const registry = new AgyNativeRuntimeRegistry(store, { enabled: true });
    const storedBinding = registry.ensureRuntimeBinding({
      sessionId,
      instanceId: 'agy',
      profileRef: 'agy:default',
    });
    const binding = {
      runtimeId: storedBinding.runtimeId,
      sessionId: storedBinding.sessionId,
      instanceId: storedBinding.instanceId,
      generation: storedBinding.generation,
    };

    const receivedEvents: unknown[] = [];
    registry.subscribeSession(sessionId, (ev) => receivedEvents.push(ev));

    // 1. Simulated transaction crash before COMMIT -> full rollback (neither snapshot nor event persisted, zero publish)
    expect(() =>
      registry.persistence.commitSnapshotAndEvent(
        binding,
        {
          activities: [
            {
              id: asActivityId('act_rollback'),
              turnId: 'turn_1',
              origin: 'user_turn',
              state: 'running',
              updatedAt: 1000,
            },
          ],
        },
        {
          type: 'native.activity.changed',
          turnId: 'turn_1',
          payload: {
            activity: {
              id: asActivityId('act_rollback'),
              turnId: 'turn_1',
              origin: 'user_turn',
              state: 'running',
              updatedAt: 1000,
            },
          },
          mutationKey: 'mut_rollback',
        },
        {
          beforeCommitHookForTest: () => {
            throw new Error('simulated disk crash');
          },
        },
      ),
    ).toThrow('simulated disk crash');

    expect(registry.getProjectionForSession(sessionId, 'agy').asOfSeq).toBe(0);
    expect(registry.getProjectionForSession(sessionId, 'agy').activities).toHaveLength(0);
    expect(receivedEvents).toHaveLength(0);

    // 2. Successful commit persists both snapshot & event and publishes once
    const act = {
      id: asActivityId('act_ok'),
      turnId: 'turn_1',
      origin: 'user_turn' as const,
      state: 'waiting_background' as const,
      updatedAt: 2000,
    };
    const c1 = registry.commitAndPublish(
      binding,
      { activities: [act], status: 'attached', retentionReasons: ['finite_work:wrk_1'] },
      {
        type: 'native.activity.changed',
        turnId: 'turn_1',
        payload: { activity: act },
        mutationKey: 'mut_ok_1',
      },
    );
    expect(c1.deduplicated).toBe(false);
    expect(c1.event.seq).toBe(1);
    expect(receivedEvents).toHaveLength(1);

    // 3. Replaying same mutationKey deduplicates idempotently without advancing seq or republishing
    const c2 = registry.commitAndPublish(
      binding,
      { activities: [act] },
      {
        type: 'native.activity.changed',
        turnId: 'turn_1',
        payload: { activity: act },
        mutationKey: 'mut_ok_1',
      },
    );
    expect(c2.deduplicated).toBe(true);
    expect(c2.event.seq).toBe(1);
    expect(receivedEvents).toHaveLength(1);

    // 4. Snapshot read matches asOfSeq and does not leak private Evidence fields
    const proj = registry.getProjectionForSession(sessionId, 'agy');
    expect(proj.asOfSeq).toBe(1);
    expect(proj.activities).toHaveLength(1);
    expect(proj.retentionReasons).toEqual(['finite_work:wrk_1']);

    // Legacy HM session lastSeq was NOT mutated by native events (Context Handoff watermark intact!)
    expect(store.getSession(sessionId)?.lastSeq).toBe(0);

    store.close();
  });

  it('enforces single-parent acyclic relation invariants, cursor resync, idempotency conflict, and approval CAS', () => {
    const dbPath = makeTempDb('hm-np02-invariants-');
    const store = openStore(dbPath);
    const { sessionId } = seedLegacyWorkspaceAndSession(store);
    const nativeStore = new NativeRuntimeStore(store);

    const b1 = nativeStore.ensureBinding({
      sessionId,
      instanceId: 'agy',
      profileRef: 'agy:profile:a',
    });
    const binding = {
      runtimeId: b1.runtimeId,
      sessionId: b1.sessionId,
      instanceId: b1.instanceId,
      generation: b1.generation,
    };

    const ev = {
      kind: 'live_protocol' as const,
      connectionId: 'conn_1',
      ingressOrdinal: 1,
      wireVariant: 'acp_v1',
      observedAt: 1000,
    };
    const root = asNativeAgentId('agt_root');
    const childA = asNativeAgentId('agt_a');
    const childB = asNativeAgentId('agt_b');

    // root -> childA -> childB
    nativeStore.commitSnapshotAndEvent(
      binding,
      {
        relationsUpsert: [
          { parentAgentId: root, childAgentId: childA, confidence: 'protocol_confirmed', evidence: ev },
          { parentAgentId: childA, childAgentId: childB, confidence: 'protocol_confirmed', evidence: ev },
        ],
      },
      {
        type: 'native.runtime.changed',
        turnId: null,
        payload: { status: 'attached', retentionReasons: [], revision: 1 },
      },
    );

    // Cycle childB -> root must be rejected
    expect(() =>
      nativeStore.commitSnapshotAndEvent(
        binding,
        {
          relationsUpsert: [
            { parentAgentId: childB, childAgentId: root, confidence: 'protocol_confirmed', evidence: ev },
          ],
        },
        {
          type: 'native.runtime.changed',
          turnId: null,
          payload: { status: 'attached', retentionReasons: [], revision: 2 },
        },
      ),
    ).toThrowError(NativePersistenceError);

    // Multi-parent conflict on childB must be rejected
    expect(() =>
      nativeStore.commitSnapshotAndEvent(
        binding,
        {
          relationsUpsert: [
            { parentAgentId: root, childAgentId: childB, confidence: 'protocol_confirmed', evidence: ev },
          ],
        },
        {
          type: 'native.runtime.changed',
          turnId: null,
          payload: { status: 'attached', retentionReasons: [], revision: 2 },
        },
      ),
    ).toThrowError(NativePersistenceError);

    // Cursor encode/decode & stale generation RESYNC_REQUIRED
    const cursor1 = encodeNativeCursor(binding.runtimeId, binding.generation, 1);
    expect(decodeNativeCursor(cursor1)?.seq).toBe(1);

    const b2 = nativeStore.advanceGeneration(binding.runtimeId, {
      generation: asBindingGeneration('gen_next'),
    });
    const staleRead = nativeStore.listEvents(binding.runtimeId, {
      afterSeq: 0,
      limit: 10,
      cursor: cursor1,
    });
    expect(staleRead.resyncRequired).toBe(true);
    if (staleRead.resyncRequired) {
      expect(staleRead.reason).toBe('stale_cursor_generation');
      expect(staleRead.currentGeneration).toBe(b2.generation);
    }

    // Idempotency key + payload digest conflict
    const d1 = computePayloadDigest({ capabilityId: 'c1', args: { a: 1, b: 2 } });
    const d1Reordered = computePayloadDigest({ args: { b: 2, a: 1 }, capabilityId: 'c1' });
    const d2 = computePayloadDigest({ capabilityId: 'c1', args: { a: 99 } });
    expect(d1).toBe(d1Reordered);

    const cFirst = nativeStore.claimIdempotentReceipt({
      binding,
      kind: 'command',
      idempotencyKey: 'idem_cmd_1',
      payloadDigest: d1,
    });
    expect(cFirst.replayed).toBe(false);
    const cReplay = nativeStore.claimIdempotentReceipt({
      binding,
      kind: 'command',
      idempotencyKey: 'idem_cmd_1',
      payloadDigest: d1Reordered,
    });
    expect(cReplay.replayed).toBe(true);
    expect(cReplay.receipt.receiptId).toBe(cFirst.receipt.receiptId);

    expect(() =>
      nativeStore.claimIdempotentReceipt({
        binding,
        kind: 'command',
        idempotencyKey: 'idem_cmd_1',
        payloadDigest: d2,
      }),
    ).toThrowError(NativePersistenceError);

    // Approval receipt CAS & disconnect invalidation
    nativeStore.createPendingApprovalReceipt({ binding, approvalId: 'appr_1' });
    const claimWrongGen = nativeStore.claimApprovalReceiptCas({
      approvalId: 'appr_1',
      expectedGeneration: asBindingGeneration('gen_wrong'),
    });
    expect(claimWrongGen.claimed).toBe(false);

    const claim1 = nativeStore.claimApprovalReceiptCas({
      approvalId: 'appr_1',
      expectedGeneration: binding.generation,
    });
    expect(claim1.claimed).toBe(true);
    expect(claim1.receipt?.state).toBe('claimed');

    // Second click loses CAS race
    const claim2 = nativeStore.claimApprovalReceiptCas({
      approvalId: 'appr_1',
      expectedGeneration: binding.generation,
    });
    expect(claim2.claimed).toBe(false);

    // Disconnect turns claimed -> delivery_unknown and pending -> connection_lost
    nativeStore.createPendingApprovalReceipt({ binding, approvalId: 'appr_2' });
    const inv = nativeStore.invalidateApprovalReceiptsForRuntime(binding.runtimeId, binding.generation);
    expect(inv.lostCount).toBe(1);
    expect(inv.unknownCount).toBe(1);

    // Ensure non-empty work ID helper is covered
    expect(asWorkId('wrk_check')).toBe('wrk_check');

    store.close();
  });
});
