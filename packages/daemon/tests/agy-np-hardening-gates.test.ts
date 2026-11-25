import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  asActivityId,
  asBindingGeneration,
  asNativeAgentId,
  asRuntimeId,
  asWorkId,
  asWorkflowId,
  type NativeWsServerFrame,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { collectNativeEcosystemCatalogSnapshot } from '../src/harnesses/agy/agy-ecosystem.js';
import {
  AgyNativeEcosystemService,
  DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
  validateAuthorizedDirectory,
} from '../src/harnesses/agy/native/ecosystem/index.js';
import { createAgyLaunchContext } from '../src/harnesses/agy/agy-launch-context.js';
import {
  AgyNativeArtifactService,
  AgyPlanDiffBrowserObserver,
  DEFAULT_AGY_ARTIFACT_FEATURE_GATES,
  redactSensitiveContent,
} from '../src/harnesses/agy/native/artifacts/index.js';
import {
  AgyNativeRecoveryService,
  AgyProcessTreeTeardownCoordinator,
  AgyRecoveryHistorySource,
  DEFAULT_AGY_NATIVE_RECOVERY_CONFIG,
  negotiateAcpProtocol,
  type TeardownTransport,
} from '../src/harnesses/agy/native/recovery/index.js';
import {
  NativePermissionRouter,
  StubNativeRequestTargetResolver,
} from '../src/harnesses/agy/native/requests/index.js';
import {
  AgyNativeRuntimeRegistry,
  DEFAULT_AGY_NATIVE_FEATURE_FLAGS,
  type NativeIngress,
} from '../src/harnesses/agy/native/wiring/index.js';
import { GoalScheduleTasksObserver } from '../src/harnesses/agy/native/workflows/tasks/index.js';
import { AgySwarmObserver } from '../src/harnesses/agy/native/workflows/swarm/swarm-observer.js';
import { DEFAULT_SWARM_OBSERVER_GATES } from '../src/harnesses/agy/native/workflows/swarm/contracts.js';
import { AgyTeamworkWorkflowObserver } from '../src/harnesses/agy/native/workflows/teamwork/observer.js';
import { DEFAULT_TEAMWORK_FEATURE_GATES } from '../src/harnesses/agy/native/workflows/teamwork/ports.js';
import { createDaemon } from '../src/server/app.js';

const tempDirs: string[] = [];
const activeDaemons: Array<ReturnType<typeof createDaemon>> = [];
const activeRouters: NativePermissionRouter[] = [];
const openStores: HarnessMateStore[] = [];

function makeTempDir(prefix: string): string {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, prefix));
  tempDirs.push(dir);
  return dir;
}

function makeBinding(overrides: Partial<RuntimeBinding> = {}): RuntimeBinding {
  return {
    runtimeId: overrides.runtimeId ?? asRuntimeId('nrt_hardening_1'),
    sessionId: overrides.sessionId ?? 'sess_hardening_1',
    instanceId: overrides.instanceId ?? 'agy',
    generation: overrides.generation ?? asBindingGeneration('gen_1'),
  };
}

function createFakeJunction(targetDir: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (activeRouters.length > 0) {
    activeRouters.pop()?.dispose();
  }
  while (activeDaemons.length > 0) {
    const d = activeDaemons.pop();
    await d?.stop().catch(() => {});
  }
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

describe('NP-16 T18 · Scale Bounds, Pagination, WS Overflow & Concurrent Request CAS', () => {
  it('enforces 500-event REST cursor pagination, emits explicit WS resync when backlog exceeds 10,000, and keeps legacy lastSeq intact', async () => {
    const tmp = makeTempDir('hm-np16-t18-');
    const daemon = createDaemon({ dataDir: path.join(tmp, 'data'), port: 0, webDistDir: null });
    activeDaemons.push(daemon);
    const { port } = await daemon.start();

    const ws = daemon.store.createWorkspace({
      id: 'ws_t18',
      name: 'T18 WS',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: 1000,
    });
    const session = daemon.store.createSession({
      id: 'sess_t18',
      workspaceId: ws.id,
      harnessId: 'agy',
      harnessKind: 'agy',
      nativeSessionId: 'nat_t18',
      cwd: tmp,
      worktreeBranch: null,
      title: 'T18 Overflow Test',
      status: 'idle',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'medium',
      permissionMode: 'manual',
      lastSeq: 3,
      createdAt: 1000,
      updatedAt: 1000,
    });

    daemon.nativeRegistry.setFeatureFlags({ enabled: true, nativeLifecycle: true });
    const stored = daemon.nativeRegistry.ensureRuntimeBinding({
      sessionId: session.id,
      instanceId: 'agy',
      profileRef: 'agy:default',
      status: 'attached',
    });
    const binding = {
      runtimeId: stored.runtimeId,
      sessionId: stored.sessionId,
      instanceId: stored.instanceId,
      generation: stored.generation,
    };

    // Commit 10,025 events (> DEFAULT_MAX_REPLAY_EVENTS = 10_000 in ws-feed.ts) via real registry path
    for (let seq = 1; seq <= 10_025; seq += 1) {
      daemon.nativeRegistry.commitAndPublish(
        binding,
        {},
        {
          type: 'native.runtime.changed',
          turnId: null,
          payload: { status: 'attached', retentionReasons: [], revision: seq },
        },
      );
    }

    // Legacy watermark must remain completely untouched
    expect(daemon.store.getSession(session.id)?.lastSeq).toBe(3);

    // REST cursor pagination rejects oversized limits (>500) cleanly with 400 and caps page size to 500
    const badLimitPage = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/events?afterSeq=0&limit=2000`,
    });
    expect(badLimitPage.statusCode).toBe(400);

    const firstPage = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/events?afterSeq=0&limit=500`,
    });
    expect(firstPage.statusCode).toBe(200);
    const body = firstPage.json();
    expect(body.events).toHaveLength(500);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBeTruthy();

    // WebSocket replay from afterSeq=0 over > 10,000 backlog must surface native_resync_required instead of silent truncation
    const wsFrame = await new Promise<NativeWsServerFrame>((resolve, reject) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/sessions/${session.id}/native/ws?token=${encodeURIComponent(daemon.config.localToken)}`,
      );
      client.on('error', reject);
      client.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8')) as NativeWsServerFrame;
        if (frame.op === 'native_hello') {
          client.send(JSON.stringify({ op: 'subscribe_native', schemaVersion: 1, afterSeq: 0 }));
        } else if (frame.op === 'native_resync_required' || frame.op === 'native_replay_complete') {
          client.close();
          resolve(frame);
        }
      });
    });

    expect(wsFrame.op).toBe('native_resync_required');
  }, 30_000);

  it('handles 20 concurrent pending native requests and 20 racing double-resolve calls via single-write CAS', async () => {
    const tmp = makeTempDir('hm-np16-req20-');
    const store = new HarnessMateStore(path.join(tmp, 'req.sqlite'));
    openStores.push(store);
    store.createWorkspace({
      id: 'ws_req20',
      name: 'Req20',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: 1000,
    });
    store.createSession({
      id: 'sess_req20',
      workspaceId: 'ws_req20',
      harnessId: 'agy',
      harnessKind: 'agy',
      nativeSessionId: 'nat_req20',
      cwd: tmp,
      worktreeBranch: null,
      title: '20 Concurrent Requests',
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const registry = new AgyNativeRuntimeRegistry(store, { enabled: true, nativePermissions: true });
    const stored = registry.ensureRuntimeBinding({
      sessionId: 'sess_req20',
      instanceId: 'agy',
      profileRef: 'agy:default',
      status: 'attached',
    });
    const binding = {
      runtimeId: stored.runtimeId,
      sessionId: stored.sessionId,
      instanceId: stored.instanceId,
      generation: stored.generation,
    };

    const resolver = new StubNativeRequestTargetResolver();
    resolver.registerRootSession(binding, 'conn_req20', 'nat_req20');
    const router = new NativePermissionRouter(registry, { targetResolver: resolver });
    activeRouters.push(router);

    let wireWrites = 0;
    for (let i = 0; i < 20; i += 1) {
      router.onIncomingRequest({
        binding,
        connectionId: 'conn_req20',
        ingressOrdinal: i + 1,
        channel: 'live',
        wireRequestId: `req_wire_${i}`,
        method: 'session/request_permission',
        params: {
          sessionId: 'nat_req20',
          toolCall: { toolCallId: `tc_${i}`, title: `Tool #${i}`, kind: 'execute' },
          options: [
            { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
          ],
        },
        respond: () => {
          wireWrites += 1;
          return true;
        },
        respondError: () => true,
      });
    }

    const pending = router.listPendingRequests(binding);
    expect(pending).toHaveLength(20);

    const outcomes = await Promise.all(
      pending.flatMap((req, idx) => [
        router.resolveWithCas({
          binding,
          approvalId: req.approvalId,
          request: {
            generation: binding.generation,
            outcome: 'selected',
            optionId: 'allow_once',
            idempotencyKey: `idem_a_${idx}`,
          },
          resolvedBy: 'desktop',
        }),
        router.resolveWithCas({
          binding,
          approvalId: req.approvalId,
          request: {
            generation: binding.generation,
            outcome: 'selected',
            optionId: 'reject_once',
            idempotencyKey: `idem_b_${idx}`,
          },
          resolvedBy: 'remote',
        }),
      ]),
    );

    expect(wireWrites).toBe(20);
    expect(outcomes.filter((o) => !o.conflict && o.receiptState === 'response_written')).toHaveLength(20);
    expect(outcomes.filter((o) => o.conflict)).toHaveLength(20);
    expect(router.listPendingRequests(binding)).toHaveLength(0);
  });
});

describe('NP-16 G3 Wave-2 Default Feature Gates & Negative Cases (NP-12 / NP-13 / NP-14 / NP-15)', () => {
  it('verifies all shared and domain default feature gates are closed', () => {
    expect(DEFAULT_AGY_NATIVE_FEATURE_FLAGS).toEqual({
      enabled: false,
      nativeLifecycle: false,
      nativePermissions: false,
      nativeCommands: false,
      nativeWorkflowObservation: false,
      nativeTasksObservation: false,
      observatoryTap: false,
      acpV2Preview: false,
    });
    expect(DEFAULT_SWARM_OBSERVER_GATES).toEqual({
      swarmEnabled: false,
      boardFeedEnabled: false,
      localBoardSnapshotEnabled: false,
      liveLaunchEnabled: false,
    });
    expect(DEFAULT_TEAMWORK_FEATURE_GATES).toEqual({
      teamworkEnabled: false,
      reviewControlEnabled: false,
    });
    expect(DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES.ecosystemReadEnabled).toBe(false);
    expect(DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES.officialOptInQueryEnabled).toBe(false);
    expect(DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES.privateRuntimeReadEnabled).toBe(false);
    expect(Object.values(DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES).every((v) => v === false)).toBe(true);
    expect(DEFAULT_AGY_ARTIFACT_FEATURE_GATES).toEqual({
      nativeArtifactsEnabled: false,
      reviewControlEnabled: false,
      mediaArtifactsEnabled: false,
    });
    expect(DEFAULT_AGY_NATIVE_RECOVERY_CONFIG.activeReconcileEnabled).toBe(false);
    expect(DEFAULT_AGY_NATIVE_RECOVERY_CONFIG.allowV2Preview).toBe(false);
    expect(DEFAULT_AGY_NATIVE_RECOVERY_CONFIG.strictProfileGuard).toBe(true);

    const swarmOff = new AgySwarmObserver();
    expect(swarmOff.getGates().swarmEnabled).toBe(false);
    const teamworkOff = new AgyTeamworkWorkflowObserver();
    expect(teamworkOff.getFeatureGates().teamworkEnabled).toBe(false);

    expect(new GoalScheduleTasksObserver().isEnabled()).toBe(false);
  });

  it('NP-12 negative cases: blocks history_replay, rejects host paths in verificationArtifactIds, and refuses OS timezone fallback', () => {
    const observer = new GoalScheduleTasksObserver({ enabled: true, strictMode: true, now: () => 1_764_200_000_000 });
    const binding = makeBinding({ sessionId: 'sess_np12_neg' });
    observer.registerBinding({
      binding,
      connectionId: 'conn_np12',
      rootNativeSessionId: 'nat_np12',
    });

    const replayIngest = observer.acceptFrame({
      binding,
      connectionId: 'conn_np12',
      ingressOrdinal: 1,
      channel: 'history_replay',
      originSession: 'nat_np12',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_np12',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_sched_replay',
            toolName: 'schedule',
            status: 'in_progress',
            rawInput: { CronExpression: '0 * * * *', scheduleId: 'sched_replay', timezone: 'UTC' },
          },
        },
      },
    });
    expect(replayIngest.accepted).toBe(false);

    // Invalid timezone + host path rejection in Goal verification artifacts
    const schedRes = observer.acceptFrame({
      binding,
      connectionId: 'conn_np12',
      ingressOrdinal: 2,
      channel: 'live',
      originSession: 'nat_np12',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_np12',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_sched_tz',
            toolName: 'schedule',
            status: 'in_progress',
            rawInput: {
              DurationSeconds: 60,
              scheduleId: 'sched_invalid_tz',
              timezone: 'Not/A_Real_Zone',
            },
          },
        },
      },
    });
    expect(schedRes.accepted).toBe(true);
    const sched = observer.getScheduleSnapshot(binding, schedRes.workflowId!)!;
    expect(sched.timezone.kind).toBe('unknown');
    expect(sched.nextAt.kind).toBe('unknown');

    const goalRes = observer.acceptFrame({
      binding,
      connectionId: 'conn_np12',
      ingressOrdinal: 3,
      channel: 'live',
      originSession: 'nat_np12',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_np12',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_goal_path',
            toolName: 'goal',
            status: 'in_progress',
            rawInput: {
              goalId: 'goal_neg_1',
              objective: 'Verify hardening',
            },
            rawOutput: {
              verificationArtifactIds: ['C:\\Users\\victim\\.ssh\\id_rsa', '../etc/passwd', 'art_valid_01'],
            },
          },
        },
      },
    });
    expect(goalRes.accepted).toBe(true);
    const goal = observer.getGoalSnapshot(binding, goalRes.workflowId!)!;
    expect(goal.verificationArtifactIds).toEqual(['art_valid_01']);

    // Stale connection rejected cleanly
    const stale = observer.acceptFrame({
      binding,
      connectionId: 'conn_old',
      ingressOrdinal: 4,
      channel: 'live',
      originSession: 'nat_np12',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_np12',
          update: { sessionUpdate: 'tool_call', toolCallId: 'tc_stale', toolName: 'goal', status: 'running' },
        },
      },
    });
    expect(stale.accepted).toBe(false);
    expect(observer.getDiagnostics().some((d) => d.code === 'wrong_connection_rejected')).toBe(true);
  });

  it('NP-13 negative cases: blocks junction/relative additionalDirs and enforces closed opt-in / private runtime gates', async () => {
    const tmp = makeTempDir('hm-np16-np13-');
    const outsideDir = path.join(tmp, 'outside-target');
    const linkDir = path.join(tmp, 'dir-junction');
    const realDir = path.join(tmp, 'real-dir');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(realDir, { recursive: true });

    expect(validateAuthorizedDirectory('../escape', 'win32').reasonCode).toBe('traversal_rejected');
    expect(validateAuthorizedDirectory('relative\\dir', 'win32').reasonCode).not.toBe('ok');
    expect(validateAuthorizedDirectory('C:\\Root\u0000Null', 'win32').reasonCode).not.toBe('ok');

    if (createFakeJunction(outsideDir, linkDir)) {
      const checkLink = validateAuthorizedDirectory(linkDir, process.platform);
      expect(checkLink.reasonCode).toBe('symlink_escape_rejected');
    }

    const svc = new AgyNativeEcosystemService();

    const profilesRoot = path.join(tmp, 'profiles');
    const expectedGeminiDir = path.join(profilesRoot, 'agy-1', 'gemini');
    const profile = {
      instanceId: 'agy-1',
      displayName: 'Same Name Account',
      isolationMode: 'profile_isolated' as const,
      authMethod: 'oauth-personal' as const,
      appDataDirName: 'antigravity-cli',
      geminiDir: expectedGeminiDir,
      defaults: { additionalDirectories: [realDir] },
      enabled: true,
    };
    const launchContext = createAgyLaunchContext({
      instanceId: profile.instanceId,
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      binaryPath: 'agy.exe',
      geminiDir: expectedGeminiDir,
    });

    const snapshot = svc.collectSnapshot({
      profile,
      launchContext,
      profilesRootDir: profilesRoot,
      workspaceRoot: tmp,
      userHome: path.join(tmp, 'home'),
    });
    expect(snapshot.gatesClosed).toBe(true);
    expect(snapshot.customAgents.items).toEqual([]);
    expect(snapshot.skills.items).toEqual([]);
    expect(snapshot.rules.items).toEqual([]);

    const closedQuery = await svc.runOptInOfficialQuery({
      queryKind: 'skills',
      profile,
      launchContext,
      workspaceRoot: tmp,
      source: 'agy_cli',
      profileVerified: true,
      userOptInConfirmed: true,
    });
    expect(closedQuery.executed).toBe(false);
    expect(closedQuery.reasonCode).toBe('OPT_IN_QUERY_GATE_DISABLED');

    const gatedCatalog = collectNativeEcosystemCatalogSnapshot({
      profile,
      launchContext,
      profilesRootDir: path.join(tmp, 'profiles'),
      workspaceRoot: tmp,
      userHome: path.join(tmp, 'home'),
    });
    expect(gatedCatalog.gatesClosed).toBe(true);
  });

  it('NP-14 negative cases: keeps gates closed, rejects XSS/spoofed PNG/junction artifacts, and blocks history_replay observer frames', () => {
    const tmp = makeTempDir('hm-np16-np14-');
    const rootDir = path.join(tmp, 'brain-root');
    const sessDir = path.join(rootDir, 'nat_np14_neg');
    const outsideDir = path.join(tmp, 'outside');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // Spoofed PNG magic header (SVG text inside .png!) must be excluded even when mediaArtifactsEnabled=true
    const fakePng = path.join(sessDir, 'spoofed.png');
    fs.writeFileSync(fakePng, '<svg onload="alert(1)"></svg>', 'utf8');

    // Forbidden .html artifact & NUL byte artifact must both be excluded by AgyNativeArtifactService
    fs.writeFileSync(path.join(sessDir, 'page.html'), '<script>alert(1)</script>', 'utf8');
    fs.writeFileSync(path.join(sessDir, 'nul.txt'), Buffer.from('abc\x00def'));

    const redaction = redactSensitiveContent(
      'Bearer ya29.secretTokenHere9999 C:\\Users\\victim\\repo\\secret.ts <iframe src="javascript:alert(1)">',
    );
    expect(redaction.content).not.toContain('ya29.secretTokenHere9999');
    expect(redaction.content).not.toContain('C:\\Users\\victim');
    expect(redaction.secretsRedactedCount).toBeGreaterThan(0);
    expect(redaction.hostPathsRedactedCount).toBeGreaterThan(0);

    const svc = new AgyNativeArtifactService();
    const bMedia = makeBinding({ sessionId: 'sess_np14_media' });
    svc.attachConnection(bMedia, {
      connectionId: 'conn_media',
      rootNativeSessionId: 'nat_np14_neg',
      appDataPath: rootDir,
    });
    expect(svc.createTeamworkArtifactReviewPort().getReviewCapability(bMedia, 'any_art').reasonCode).toBe(
      'review_control_gate_disabled',
    );
    expect(svc.syncBrainArtifacts(bMedia).some((a) => a.contentKind === 'media_ref')).toBe(false);
    svc.configureGates({ mediaArtifactsEnabled: true });
    const syncedMedia = svc.syncBrainArtifacts(bMedia);
    expect(syncedMedia.some((a) => a.title === 'spoofed.png' || a.title === 'page.html' || a.title === 'nul.txt')).toBe(false);
    svc.configureGates({ mediaArtifactsEnabled: false });

    const observer = new AgyPlanDiffBrowserObserver();
    const b = makeBinding({ sessionId: 'sess_np14_obs' });
    observer.attachConnection(b, {
      connectionId: 'conn_np14',
      rootNativeSessionId: 'nat_1',
      appDataPath: rootDir,
    });
    const replayRes = observer.acceptFrame({
      binding: b,
      connectionId: 'conn_np14',
      ingressOrdinal: 1,
      channel: 'history_replay',
      originSession: 'nat_1',
      wire: {
        method: 'session/update',
        params: { sessionId: 'nat_1', update: { sessionUpdate: 'plan', entries: [{ content: 'Step 1', status: 'pending' }] } },
      },
    } as NativeIngress);
    expect(replayRes.accepted).toBe(false);
    expect(replayRes.reasonCode).toBe('history_replay_isolated');
  });

  it('NP-15 negative cases: keeps reconcile & ACP v2 disabled by default, rejects unconfirmed v2, blocks replay requests, and refuses unowned PID teardown', async () => {
    const tmp = makeTempDir('hm-np16-np15-');
    const store = new HarnessMateStore(path.join(tmp, 'np15.sqlite'));
    openStores.push(store);
    const registry = new AgyNativeRuntimeRegistry(store, { enabled: true });
    const recovery = new AgyNativeRecoveryService({ registry });

    // Startup reconcile skips when activeReconcileEnabled=false
    const startup = recovery.reconcileOnDaemonStartup();
    expect(startup.skipped).toBe(true);
    expect(startup.reasonCode).toBe('active_reconcile_disabled');

    // ACP v2 fails closed when allowV2Preview=false OR v2 schema unconfirmed
    const v2Denied = negotiateAcpProtocol({
      requestedProtocol: 2,
      allowV2Preview: false,
      initializeResult: {
        protocolVersion: 2,
        agentInfo: { name: 'antigravity-cli', version: '1.5.17' },
        agentCapabilities: { sessionCapabilities: { replayCursor: true } },
      },
    });
    expect(v2Denied.ok).toBe(false);
    if (!v2Denied.ok) {
      expect(v2Denied.reasonCode).toBe('v2_schema_unconfirmed');
    }

    const v2Unconfirmed = negotiateAcpProtocol({
      requestedProtocol: 2,
      allowV2Preview: true,
      initializeResult: {
        protocolVersion: 2,
        agentInfo: { name: 'antigravity-cli', version: '1.5.17' },
        agentCapabilities: {},
      },
    });
    expect(v2Unconfirmed.ok).toBe(false);

    // History replay blocks server requests
    const histSource = new AgyRecoveryHistorySource();
    const binding = makeBinding({ sessionId: 'sess_np15_rpl' });
    const sanitized = histSource.sanitizeHistoryReplayFrames({
      captureId: 'hist_neg',
      expectedBinding: binding,
      frames: [
        {
          binding,
          connectionId: 'conn_replay',
          ingressOrdinal: 1,
          channel: 'history_replay',
          originSession: 'nat_1',
          wire: {
            id: 77,
            method: 'session/request_permission',
            params: { sessionId: 'nat_1', options: [{ optionId: 'allow_once', name: 'Allow' }] },
          },
        },
      ],
    });
    expect(sanitized.blockedServerRequestCount).toBe(1);
    expect(sanitized.emitsLiveApprovals).toBe(false);

    // Process-tree teardown refuses non-owned PIDs
    const coordinator = new AgyProcessTreeTeardownCoordinator();
    let killCalled = false;
    const fakeTransport: TeardownTransport = {
      sendCancel: () => true,
      isProcessAlive: () => true,
      killProcessTree: async () => {
        killCalled = true;
        return { ok: true, method: 'taskkill_tree' };
      },
      wait: async () => {},
      now: () => 1_000,
    };
    const refused = await coordinator.teardownConnection({
      binding,
      connectionId: 'conn_fake',
      nativeSessionId: 'nat_1',
      pid: 999_999,
      hasActiveTurnOrWork: true,
      compat: {
        band: 'verified_handshake_v1',
        cliVersion: '1.5.17',
        supportsReliableCancel: true,
        supportsSessionClose: true,
        requiresIdleGapLoadGuard: true,
        degradedToSafeMode: false,
        notes: 'test',
      },
      transport: fakeTransport,
      platform: 'win32',
    });
    expect(refused.refusedNotOwned).toBe(true);
    expect(refused.treeKillInvoked).toBe(false);
    expect(killCalled).toBe(false);
  });

  it('keeps Codex and Claude legacy sessions unaffected when AGY native gates are enabled or disabled', () => {
    const tmp = makeTempDir('hm-np16-other-harness-');
    const store = new HarnessMateStore(path.join(tmp, 'multi.sqlite'));
    openStores.push(store);
    const ws = store.createWorkspace({
      id: 'ws_multi',
      name: 'Multi',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: 1000,
    });
    const codexSess = store.createSession({
      id: 'sess_codex_reg',
      workspaceId: ws.id,
      harnessId: 'codex',
      harnessKind: 'codex',
      nativeSessionId: null,
      cwd: tmp,
      worktreeBranch: null,
      title: 'Codex Regression',
      status: 'idle',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });
    const claudeSess = store.createSession({
      id: 'sess_claude_reg',
      workspaceId: ws.id,
      harnessId: 'claude',
      harnessKind: 'claude',
      nativeSessionId: null,
      cwd: tmp,
      worktreeBranch: null,
      title: 'Claude Regression',
      status: 'idle',
      model: 'claude-sonnet',
      reasoningEffort: 'medium',
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const registry = new AgyNativeRuntimeRegistry(store); // defaults off
    store.appendEvent(codexSess.id, 'message.delta', { delta: 'codex ok' }, 'turn_c1');
    store.appendEvent(claudeSess.id, 'message.delta', { delta: 'claude ok' }, 'turn_l1');

    expect(store.getSession(codexSess.id)?.lastSeq).toBe(1);
    expect(store.getSession(claudeSess.id)?.lastSeq).toBe(1);
    expect(registry.getProjectionForSession(codexSess.id, 'codex').enabled).toBe(false);
    expect(registry.getProjectionForSession(claudeSess.id, 'claude').enabled).toBe(false);
  });
});
