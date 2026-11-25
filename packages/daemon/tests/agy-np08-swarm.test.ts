import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  asBindingGeneration,
  NativeWorkflowDtoSchema,
  NativeWorkflowResourceItemDtoSchema,
} from '@harnessmate/protocol';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { AgyNativeCommandCatalogService } from '../src/harnesses/agy/native/commands/catalog.js';
import { AgyNativeRuntimeRegistry } from '../src/harnesses/agy/native/wiring/registry.js';
import {
  AgySwarmObserver,
  DEFAULT_SWARM_OBSERVER_GATES,
  SWARM_OBSERVER_CONTRACT_REVISION,
  VERIFIED_LOCAL_BOARD_SCHEMAS,
  createSyntheticSwarmBinding,
  createT10FullStructuredSwarmFrames,
  createT10UpstreamLimitedSwarmFrames,
  registerSwarmCapabilityDescriptors,
  sanitizeSwarmPublicText,
} from '../src/harnesses/agy/native/workflows/swarm/index.js';

const tempDirs: string[] = [];

function createDDriveTempDir(prefix: string): string {
  // Always create temporary directories on D: drive within the worktree root (per NP-08 rules).
  const base = path.join(process.cwd(), '.tmp-np08-tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
  const base = path.join(process.cwd(), '.tmp-np08-tests');
  try {
    if (fs.existsSync(base) && fs.readdirSync(base).length === 0) {
      fs.rmdirSync(base);
    }
  } catch {
    // ignore
  }
});

describe('NP-08 Swarm Observer, Shared Board & Gate Rollback [synthetic]', () => {
  it('T10-A: observes /swarm advertisement, launch receipt, worker idle -> real mention wake, confirmed approval linking, verifier failure, and coordinator settle', () => {
    let clock = 1_764_100_000_000;
    const observer = new AgySwarmObserver({
      gates: { swarmEnabled: true, boardFeedEnabled: true },
      now: () => {
        clock += 100;
        return clock;
      },
    });
    expect(observer.contractRevision).toBe(SWARM_OBSERVER_CONTRACT_REVISION);

    const binding = createSyntheticSwarmBinding();
    const fixture = createT10FullStructuredSwarmFrames({ binding });
    observer.registerBinding({
      binding,
      rootNativeSessionId: fixture.rootNativeSessionId,
      profileRef: 'profile_dedicated_test',
      sourceRef: 'acp',
      connectionId: 'conn_t10_a',
    });

    // 1. Advertisement tracking: null -> true -> false -> true
    expect(observer.getStateSnapshot(binding)?.swarmAdvertised).toBeNull();
    expect(observer.onAvailableCommandsUpdate(binding, [{ name: 'swarm' }]).advertised).toBe(true);
    expect(observer.onAvailableCommandsUpdate(binding, []).advertised).toBe(false);
    expect(observer.onAvailableCommandsUpdate(binding, [{ name: '/swarm' }]).advertised).toBe(true);

    // 2. Launch receipt stays unknown until real native coordinator evidence arrives
    const launchRes = observer.onNativeLaunchReceipt({
      binding,
      receiptId: 'rcpt_swarm_01',
      activityId: fixture.originActivityId,
      turnId: 'turn_1',
      objective: 'Verify T10 Swarm',
      modeEvidenceObserved: false,
    });
    expect(launchRes.workflowId).toBeTruthy();
    expect(launchRes.commits).toHaveLength(1);
    const afterReceipt = observer.getStateSnapshot(binding)?.workflows[0]!;
    expect(afterReceipt.workflow.state.kind).toBe('unknown');

    // 3. Replay frames 1..4 (coordinator active, worker-alpha + verifier-1 registered, worker-alpha enters idle)
    for (const frame of fixture.frames.slice(0, 4)) {
      const res = observer.acceptFrame(frame);
      expect(res.accepted).toBe(true);
      expect(res.deduplicated).toBe(false);
    }

    const snapIdle = observer.getStateSnapshot(binding)!.workflows[0]!;
    expect(snapIdle.workflow.detail.kind).toBe('swarm');
    expect(snapIdle.workflow.detail.workerIds).toHaveLength(2);
    const workerAlphaIdle = snapIdle.workers.find((w) => w.rosterName === 'worker-alpha')!;
    const verifierIdle = snapIdle.workers.find((w) => w.rosterName === 'verifier-1')!;
    expect(workerAlphaIdle.role).toBe('worker');
    expect(verifierIdle.role).toBe('verifier');
    // CRITICAL T10: idle NEVER equals finished or succeeded!
    expect(workerAlphaIdle.foreground).toMatchObject({ kind: 'known', value: 'idle' });
    expect(workerAlphaIdle.workState).toMatchObject({ kind: 'known', value: 'waiting' });
    expect(workerAlphaIdle.outcome).toBeUndefined();
    expect(workerAlphaIdle.idleWakeCount).toBe(0);

    // 4. Frames 5..6: Board post with @worker-alpha mention + system-attributed reply
    for (const frame of fixture.frames.slice(4, 6)) {
      expect(observer.acceptFrame(frame).accepted).toBe(true);
    }
    const snapMention = observer.getStateSnapshot(binding)!.workflows[0]!;
    expect(snapMention.mentions).toHaveLength(1);
    expect(snapMention.mentions[0]!.targetRosterName).toBe('worker-alpha');
    expect(snapMention.mentions[0]!.wakeObserved).toBe(false);

    // 5. Frame 7: Worker alpha wakes idle -> running after real mention
    expect(observer.acceptFrame(fixture.frames[6]!).accepted).toBe(true);
    const snapAwake = observer.getStateSnapshot(binding)!.workflows[0]!;
    const workerAwake = snapAwake.workers.find((w) => w.rosterName === 'worker-alpha')!;
    expect(workerAwake.foreground).toMatchObject({ kind: 'known', value: 'running' });
    expect(workerAwake.idleWakeCount).toBe(1);
    expect(workerAwake.lastMentionPostId).toBe('post_t10_001');
    expect(snapAwake.mentions[0]!.wakeObserved).toBe(true);

    // 6. Child approval linking: confirmed worker allowed without moving context; unknown child rejected
    const unconfirmedLink = observer.linkWorkerApproval(binding, {
      approvalId: 'appr_unknown_99',
      receiptState: 'pending',
      targetResolution: {
        scope: 'unknown_child',
        targetLineage: 'unresolved',
        turnId: null,
        isDetached: true,
        forwardedToParentSession: false,
        provenanceReason: 'unknown_non_root_wire_session',
      },
    });
    expect(unconfirmedLink.linked).toBe(false);
    expect(unconfirmedLink.diagnostic?.code).toBe('unconfirmed_approval_not_linked');

    const confirmedLink = observer.linkWorkerApproval(binding, {
      approvalId: 'appr_worker_alpha_01',
      receiptState: 'pending',
      targetResolution: {
        scope: 'confirmed_child',
        targetLineage: 'confirmed',
        agentId: workerAwake.agentId,
        turnId: null,
        isDetached: true,
        forwardedToParentSession: true,
        provenanceReason: 'forwarded_via_parent_verified_child',
      },
    });
    expect(confirmedLink.linked).toBe(true);
    expect(confirmedLink.workerAgentId).toBe(workerAwake.agentId);
    const workerPending = observer
      .getStateSnapshot(binding)!
      .workflows[0]!.workers.find((w) => w.agentId === workerAwake.agentId)!;
    expect(workerPending.foreground).toMatchObject({ kind: 'known', value: 'requires_action' });
    expect(workerPending.linkedApprovalIds).toContain('appr_worker_alpha_01');

    // Resolving approval clears requires_action cleanly
    const resolvedLink = observer.linkWorkerApproval(binding, {
      approvalId: 'appr_worker_alpha_01',
      receiptState: 'response_written',
      targetResolution: {
        scope: 'confirmed_child',
        targetLineage: 'confirmed',
        agentId: workerAwake.agentId,
        turnId: null,
        isDetached: true,
        forwardedToParentSession: true,
        provenanceReason: 'forwarded_via_parent_verified_child',
      },
    });
    expect(resolvedLink.linked).toBe(true);
    const workerAfterResolve = observer
      .getStateSnapshot(binding)!
      .workflows[0]!.workers.find((w) => w.agentId === workerAwake.agentId)!;
    expect(workerAfterResolve.foreground).toMatchObject({ kind: 'known', value: 'running' });

    // 7. Remaining frames 8..12: worker succeeds, verifier fails explicitly, coordinator settles
    for (const frame of fixture.frames.slice(7)) {
      expect(observer.acceptFrame(frame).accepted).toBe(true);
    }

    const finalWf = observer.getStateSnapshot(binding)!.workflows[0]!;
    const finalWorker = finalWf.workers.find((w) => w.rosterName === 'worker-alpha')!;
    const finalVerifier = finalWf.workers.find((w) => w.rosterName === 'verifier-1')!;
    expect(finalWorker.workState).toMatchObject({ kind: 'known', value: 'finished' });
    expect(finalWorker.outcome).toMatchObject({ kind: 'known', value: 'succeeded' });
    expect(finalVerifier.workState).toMatchObject({ kind: 'known', value: 'failed' });
    expect(finalVerifier.outcome).toMatchObject({ kind: 'known', value: 'failed' });
    expect(finalWf.workflow.state).toMatchObject({ kind: 'known', value: 'finished' });
    expect(finalWf.workflow.detail.kind).toBe('swarm');
    expect(finalWf.workflow.detail.board).toMatchObject({ kind: 'known', value: 'available' });
  });

  it('T10-B: paginates Board posts by stable postId without drift across appends, redacts secrets/paths, and deduplicates replays', () => {
    const observer = new AgySwarmObserver({
      gates: { swarmEnabled: true, boardFeedEnabled: true },
    });
    const binding = createSyntheticSwarmBinding({ runtimeId: 'nrt_np08_page' });
    observer.registerBinding({
      binding,
      rootNativeSessionId: 'native_root_page',
      profileRef: 'profile_1',
      sourceRef: 'acp',
      connectionId: 'conn_page',
    });

    const sendPost = (ordinal: number, postId: string, body: string, threadId?: string) =>
      observer.acceptFrame({
        binding,
        connectionId: 'conn_page',
        ingressOrdinal: ordinal,
        channel: 'live',
        originSession: 'native_root_page',
        wire: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'native_root_page',
            update: {
              sessionUpdate: 'swarm_board_post',
              swarmId: 'swarm_page',
              postId,
              ...(threadId ? { threadId } : {}),
              authorLabel: 'coordinator',
              summary: body,
              createdAt: 1_764_100_000_000 + ordinal * 1000,
            },
          },
        },
      });

    const r1 = sendPost(1, 'post_01', 'Check Bearer=secret_token_xyz at C:\\Users\\alice\\secret.txt');
    sendPost(2, 'post_02', 'Reply 1', 'post_01');
    sendPost(3, 'post_03', 'Reply 2', 'post_01');
    sendPost(4, 'post_04', 'A'.repeat(4500), 'post_01');

    // Duplicate ingressOrdinal is ignored
    const dup = sendPost(1, 'post_01', 'Duplicate frame');
    expect(dup.deduplicated).toBe(true);
    expect(dup.accepted).toBe(false);

    const wfId = r1.workflowId!;
    const page1 = observer.readWorkflowResource({
      binding,
      workflowId: wfId,
      resource: 'board',
      limit: 2,
    });
    expect(page1.available).toBe(true);
    expect(page1.hasMore).toBe(true);
    expect(page1.items.map((i) => (i.kind === 'board_post' ? i.postId : ''))).toEqual([
      'post_01',
      'post_02',
    ]);
    // Verify redaction on post_01
    const firstPost = NativeWorkflowResourceItemDtoSchema.parse(page1.items[0]);
    expect(firstPost.kind).toBe('board_post');
    if (firstPost.kind === 'board_post') {
      expect(firstPost.summary).not.toContain('secret_token_xyz');
      expect(firstPost.summary).not.toContain('C:\\Users\\alice');
      expect(firstPost.summary).toContain('[REDACTED_SECRET]');
      expect(firstPost.summary).toContain('[REDACTED_PATH]');
    }

    // Append post_05 mid-pagination and verify stable-ID cursor produces zero duplicates/skips
    sendPost(5, 'post_05', 'Appended mid-pagination', 'post_01');

    const page2 = observer.readWorkflowResource({
      binding,
      workflowId: wfId,
      resource: 'board',
      pageToken: page1.nextPageToken!,
      limit: 2,
    });
    expect(page2.items.map((i) => (i.kind === 'board_post' ? i.postId : ''))).toEqual([
      'post_03',
      'post_04',
    ]);
    expect(page2.hasMore).toBe(true);
    const truncatedPost = page2.items[1]!;
    expect(truncatedPost.kind === 'board_post' && truncatedPost.truncated).toBe(true);

    const page3 = observer.readWorkflowResource({
      binding,
      workflowId: wfId,
      resource: 'board',
      pageToken: page2.nextPageToken!,
      limit: 2,
    });
    expect(page3.items.map((i) => (i.kind === 'board_post' ? i.postId : ''))).toEqual(['post_05']);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextPageToken).toBeNull();

    // Tampered / unknown cursor fails cleanly
    const badCursor = observer.readWorkflowResource({
      binding,
      workflowId: wfId,
      resource: 'board',
      pageToken: 'invalid-base64-token',
      limit: 2,
    });
    expect(badCursor.available).toBe(false);
    expect(badCursor.sourceUnavailableReason).toBe('invalid_board_cursor');

    // Sanitizer also strips query secrets and unix home paths
    const redactedUrl = sanitizeSwarmPublicText('https://example.test/cb?access_token=tok123 /Users/bob/key');
    expect(redactedUrl.text).not.toContain('tok123');
    expect(redactedUrl.text).not.toContain('/Users/bob/key');
  });

  it('T10-C: refuses fabricating workers from tool titles and handles missing ACP Board feed honestly', () => {
    const observer = new AgySwarmObserver({
      gates: { swarmEnabled: true, boardFeedEnabled: true },
    });
    const binding = createSyntheticSwarmBinding({ runtimeId: 'nrt_np08_limited' });
    observer.registerBinding({
      binding,
      rootNativeSessionId: 'native_root_t10_b',
      profileRef: 'profile_1',
      sourceRef: 'acp',
      connectionId: 'conn_t10_b',
    });

    const frames = createT10UpstreamLimitedSwarmFrames({ binding });
    let wfId = null;
    for (const frame of frames) {
      const res = observer.acceptFrame(frame);
      expect(res.accepted).toBe(true);
      wfId = res.workflowId ?? wfId;
    }

    const snap = observer.getStateSnapshot(binding)!;
    const wfSnap = snap.workflows[0]!;
    // Zero fabricated workers despite "Run swarm add worker-ghost" tool call!
    expect(wfSnap.workers).toHaveLength(0);
    expect(wfSnap.workflow.detail.kind).toBe('swarm');
    expect(wfSnap.workflow.detail.workerIds).toHaveLength(0);
    expect(wfSnap.unverifiedLaunchToolCount).toBe(1);
    expect(wfSnap.workflow.detail.board).toMatchObject({ kind: 'known', value: 'upstream_limited' });
    expect(snap.diagnostics.some((d) => d.code === 'unverified_worker_title_ignored')).toBe(true);

    // Board resource reports unavailable; Coordinator logs remain readable
    const boardRes = observer.readWorkflowResource({
      binding,
      workflowId: wfId!,
      resource: 'board',
      limit: 20,
    });
    expect(boardRes.available).toBe(false);
    expect(boardRes.sourceUnavailableReason).toBe('acp_swarm_board_not_exposed');
    expect(boardRes.items).toHaveLength(0);

    const logsRes = observer.readWorkflowResource({
      binding,
      workflowId: wfId!,
      resource: 'logs',
      limit: 20,
    });
    expect(logsRes.available).toBe(true);
    expect(logsRes.items.length).toBeGreaterThanOrEqual(2);
  });

  it('T10-D: zero-code rollback gates (closing Board or Swarm gate preserves captured coordinator trajectory)', () => {
    // Default gates are ALL closed for safety
    expect(DEFAULT_SWARM_OBSERVER_GATES).toEqual({
      swarmEnabled: false,
      boardFeedEnabled: false,
      localBoardSnapshotEnabled: false,
      liveLaunchEnabled: false,
    });

    const observer = new AgySwarmObserver({
      gates: { swarmEnabled: true, boardFeedEnabled: true },
    });
    const binding = createSyntheticSwarmBinding({ runtimeId: 'nrt_np08_gate' });
    const fixture = createT10FullStructuredSwarmFrames({ binding });
    observer.registerBinding({
      binding,
      rootNativeSessionId: fixture.rootNativeSessionId,
      profileRef: 'profile_1',
      sourceRef: 'acp',
      connectionId: 'conn_t10_a',
    });

    let wfId = null;
    for (const frame of fixture.frames.slice(0, 6)) {
      const res = observer.acceptFrame(frame);
      wfId = res.workflowId ?? wfId;
    }

    // Close ONLY Board gate -> Board becomes unavailable, Coordinator trace STILL readable!
    observer.setGates({ boardFeedEnabled: false });
    const boardClosed = observer.readWorkflowResource({
      binding,
      workflowId: wfId!,
      resource: 'board',
      limit: 10,
    });
    expect(boardClosed.available).toBe(false);
    expect(boardClosed.sourceUnavailableReason).toBe('swarm_board_gate_disabled');

    const logsStillReadable = observer.readWorkflowResource({
      binding,
      workflowId: wfId!,
      resource: 'logs',
      limit: 20,
    });
    expect(logsStillReadable.available).toBe(true);
    expect(logsStillReadable.items.length).toBeGreaterThan(0);

    // Close Swarm master gate -> further coordinator updates still captured in trace, no workflow commits emitted
    observer.setGates({ swarmEnabled: false });
    const gatedFrameRes = observer.acceptFrame(fixture.frames[11]!);
    expect(gatedFrameRes.accepted).toBe(true);
    expect(gatedFrameRes.coordinatorTraceAppended).toBe(true);
    expect(gatedFrameRes.commits).toHaveLength(0);

    const logsAfterFullGateOff = observer.readWorkflowResource({
      binding,
      workflowId: wfId!,
      resource: 'logs',
      limit: 50,
    });
    expect(logsAfterFullGateOff.available).toBe(true);
    expect(logsAfterFullGateOff.items.length).toBeGreaterThan(logsStillReadable.items.length);
  });

  it('T10-E: local read-only Board snapshot fails closed by default, blocks SQLite/traversal/unknown schemas, and isolates scopes', () => {
    expect(VERIFIED_LOCAL_BOARD_SCHEMAS).toEqual([]);
    const tmpDir = createDDriveTempDir('board-snap');

    const observer = new AgySwarmObserver({
      gates: { swarmEnabled: true, boardFeedEnabled: true, localBoardSnapshotEnabled: true },
    });
    const binding = createSyntheticSwarmBinding({ runtimeId: 'nrt_np08_snap' });
    observer.registerBinding({
      binding,
      rootNativeSessionId: 'native_root_snap',
      profileRef: 'profile_snap',
      sourceRef: 'acp',
      connectionId: 'conn_snap',
    });
    const wfId = observer.acceptFrame({
      binding,
      connectionId: 'conn_snap',
      ingressOrdinal: 1,
      channel: 'live',
      originSession: 'native_root_snap',
      wire: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'native_root_snap',
          update: {
            sessionUpdate: 'swarm_coordinator_update',
            swarmId: 'swarm_snap_01',
            status: 'running',
          },
        },
      },
    }).workflowId!;

    // Write valid JSON file + fake SQLite file
    const validFile = path.join(tmpDir, 'board.json');
    fs.writeFileSync(
      validFile,
      JSON.stringify({
        schemaVersion: 'swarm_board_test_v1',
        nativeSessionId: 'native_root_snap',
        profileRef: 'profile_snap',
        workflowId: 'swarm_snap_01',
        posts: [
          {
            postId: 'snap_post_1',
            authorLabel: 'worker-alpha',
            summary: 'Snapshot post Bearer=leak_me_123',
            createdAt: 1_764_100_001_000,
          },
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(tmpDir, 'private.db'), 'SQLite format 3', 'utf8');

    // 1. Production default (empty verified schemas) fails closed!
    const prodDefault = observer.ingestReadOnlyBoardSnapshot(binding, wfId, {
      snapshotRootPath: tmpDir,
      candidateRelativeFile: 'board.json',
    });
    expect(prodDefault.available).toBe(false);
    expect(prodDefault.reasonCode).toBe('no_verified_local_board_schema');

    // 2. Private SQLite database is unconditionally blocked even with schema allowlist!
    const sqliteBlocked = observer.ingestReadOnlyBoardSnapshot(binding, wfId, {
      snapshotRootPath: tmpDir,
      candidateRelativeFile: 'private.db',
      supportedSchemas: ['swarm_board_test_v1'],
    });
    expect(sqliteBlocked.available).toBe(false);
    expect(sqliteBlocked.reasonCode).toBe('unverified_private_sqlite_blocked');

    // 3. Path traversal is blocked
    const traversalBlocked = observer.ingestReadOnlyBoardSnapshot(binding, wfId, {
      snapshotRootPath: tmpDir,
      candidateRelativeFile: '../board.json',
      supportedSchemas: ['swarm_board_test_v1'],
    });
    expect(traversalBlocked.available).toBe(false);
    expect(traversalBlocked.reasonCode).toBe('invalid_snapshot_path');

    // 4. Unknown schema version fails closed
    const unknownSchema = observer.ingestReadOnlyBoardSnapshot(binding, wfId, {
      snapshotRootPath: tmpDir,
      candidateRelativeFile: 'board.json',
      supportedSchemas: ['other_schema_v99'],
    });
    expect(unknownSchema.available).toBe(false);
    expect(unknownSchema.reasonCode).toBe('unverified_local_board_schema');

    // 5. Explicit test-allowlisted schema with matching scope succeeds as redacted read-only native_snapshot
    const allowedSnap = observer.ingestReadOnlyBoardSnapshot(binding, wfId, {
      snapshotRootPath: tmpDir,
      candidateRelativeFile: 'board.json',
      supportedSchemas: ['swarm_board_test_v1'],
    });
    expect(allowedSnap.available).toBe(true);
    expect(allowedSnap.posts).toHaveLength(1);
    expect(allowedSnap.posts[0]!.evidence.kind).toBe('native_snapshot');
    expect(allowedSnap.posts[0]!.summary).toContain('[REDACTED_SECRET]');
    expect(allowedSnap.posts[0]!.summary).not.toContain('leak_me_123');
  });

  it('T10-F: enforces scope/generation/replay isolation, transport-close staleness, SQLite registry persistence, and NP-06 catalog contribution', () => {
    const tmpDir = createDDriveTempDir('sqlite-reg');
    const dbPath = path.join(tmpDir, 'hm-np08-test.db');
    const store = new HarnessMateStore(dbPath);

    try {
      store.createWorkspace({
        id: 'ws_np08_sql',
        name: 'NP08 SQL WS',
        rootPath: tmpDir,
        isGitRepo: false,
        gitBranch: null,
        createdAt: 1000,
      });
      store.createSession({
        id: 'sess_np08_sql',
        workspaceId: 'ws_np08_sql',
        harnessId: 'agy',
        harnessKind: 'agy',
        nativeSessionId: 'native_root_t10_a',
        cwd: tmpDir,
        worktreeBranch: null,
        title: 'NP08 SQLite Test',
        status: 'idle',
        model: null,
        reasoningEffort: null,
        permissionMode: 'manual',
        lastSeq: 0,
        createdAt: 1000,
        updatedAt: 1000,
      });

      const registry = new AgyNativeRuntimeRegistry(store, {
        enabled: true,
        nativeLifecycle: true,
        nativePermissions: true,
        nativeCommands: true,
      });
      const storedBinding = registry.ensureRuntimeBinding({
        sessionId: 'sess_np08_sql',
        instanceId: 'agy',
        profileRef: 'profile_sql',
        sourceRef: 'acp',
        status: 'attached',
      });
      const binding = {
        runtimeId: storedBinding.runtimeId,
        sessionId: storedBinding.sessionId,
        instanceId: storedBinding.instanceId,
        generation: storedBinding.generation,
      };

      const observer = new AgySwarmObserver({
        gates: { swarmEnabled: true, boardFeedEnabled: true },
      });
      const fixture = createT10FullStructuredSwarmFrames({ binding });
      observer.registerBinding({
        binding,
        rootNativeSessionId: fixture.rootNativeSessionId,
        profileRef: 'profile_sql',
        sourceRef: 'acp',
        connectionId: 'conn_t10_a',
      });

      // Reject cross-profile frame
      const crossProfile = observer.acceptFrame(fixture.frames[0]!, { profileRef: 'other_profile' });
      expect(crossProfile.accepted).toBe(false);
      expect(crossProfile.diagnostic?.code).toBe('cross_profile_rejected');

      // Reject stale generation frame
      const staleGen = observer.acceptFrame({
        ...fixture.frames[0]!,
        binding: { ...binding, generation: asBindingGeneration('gen_old_999') },
      });
      expect(staleGen.accepted).toBe(false);
      expect(staleGen.diagnostic?.code).toBe('stale_generation_rejected');

      // Commit real frames into SQLite registry
      let totalPublished = 0;
      for (const frame of fixture.frames.slice(0, 7)) {
        const res = observer.acceptFrame(frame);
        totalPublished += observer.commitToRegistry(registry, binding, res.commits);
      }
      expect(totalPublished).toBeGreaterThan(0);

      // Verify persisted public projection satisfies strict DTO allowlist (zero private leaks!)
      const proj = registry.getProjectionForSession(binding.sessionId, binding.instanceId);
      expect(proj.workflows).toHaveLength(1);
      const wfDto = NativeWorkflowDtoSchema.parse(proj.workflows[0]);
      expect(wfDto.detail.kind).toBe('swarm');
      if (wfDto.detail.kind === 'swarm') {
        expect(wfDto.detail.workerIds).toHaveLength(2);
        expect(wfDto.detail.board.kind).toBe('known');
      }
      const serialized = JSON.stringify(proj);
      expect(serialized).not.toContain('conn_t10_a');
      expect(serialized).not.toContain(fixture.workerNativeId);
      expect(serialized).not.toContain(fixture.rootNativeSessionId);

      // Transport close demotes active workflow/workers to stale while preserving coordinator logs
      const closeCommits = observer.handleTransportClosed(binding, 'conn_t10_a');
      expect(closeCommits.length).toBeGreaterThan(0);
      observer.commitToRegistry(registry, binding, closeCommits);
      const projAfterClose = registry.getProjectionForSession(binding.sessionId, binding.instanceId);
      expect(projAfterClose.workflows[0]!.state.kind).toBe('stale');

      // NP-06 catalog descriptor contribution & advertisement/revocation
      const catalog = new AgyNativeCommandCatalogService();
      const disposeContrib = registerSwarmCapabilityDescriptors(catalog, {
        swarmEnabled: true,
        boardFeedEnabled: true,
        localBoardSnapshotEnabled: false,
        liveLaunchEnabled: true,
      });
      const beforeAdv = catalog.updateBindingSignals(binding, {
        profileRef: 'profile_sql',
        profileVerified: true,
        hasLiveConnection: true,
        advertisedCommands: null,
      });
      const w04Unknown = beforeAdv.snapshot.descriptors.find((d) => d.id === 'AGY-W04')!;
      expect(w04Unknown.advertised).toBeNull();
      expect(w04Unknown.launch).toBe('unknown');

      const afterAdv = catalog.applyAdvertisedCommandsUpdate(binding, [{ name: 'swarm' }]);
      const w04Adv = afterAdv.snapshot.descriptors.find((d) => d.id === 'AGY-W04')!;
      expect(w04Adv.advertised).toBe(true);
      expect(w04Adv.launch).toBe('available');
      expect(w04Adv.control).toBe('upstream_limited');

      const afterRevoke = catalog.applyAdvertisedCommandsUpdate(binding, []);
      const w04Revoked = afterRevoke.snapshot.descriptors.find((d) => d.id === 'AGY-W04')!;
      expect(w04Revoked.advertised).toBe(false);
      expect(w04Revoked.launch).toBe('unsupported');

      disposeContrib();
    } finally {
      store.close();
    }
  });
});
