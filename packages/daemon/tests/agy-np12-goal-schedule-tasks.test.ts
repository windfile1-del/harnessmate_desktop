import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NativeWorkflowDtoSchema,
  NativeWorkflowResourceResponseSchema,
  NativeWorkflowSchema,
  asActivityId,
  asBindingGeneration,
  asWorkId,
  asWorkflowId,
  sanitizeNativeWorkflowForPublic,
  type NativeWork,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import { AgyNativeCommandCatalogService } from '../src/harnesses/agy/native/commands/catalog.js';
import type { NativeIngress } from '../src/harnesses/agy/native/wiring/types.js';
import {
  APP_AUTOMATIONS_CLOSURE_RECORD,
  GoalScheduleTasksObserver,
  TASKS_PROTOCOL_EXPOSURE_ASSESSMENT,
  TASKS_WIRE_FIELD_VERSIONS,
  decodeTasksIngressFrame,
  loadTasksNdjsonFixture,
  registerTasksCapabilityDescriptors,
  replayTasksNdjson,
} from '../src/harnesses/agy/native/workflows/tasks/index.js';
import { createDaemon } from '../src/server/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'agy-np12');

const tempDirs: string[] = [];
const activeDaemons: Array<ReturnType<typeof createDaemon>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const d = activeDaemons.pop();
    await d?.stop().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

async function createNp12DaemonEnv() {
  const tmp = makeTempDir('hm-np12-');
  const daemon = createDaemon({
    dataDir: path.join(tmp, 'data'),
    port: 0,
    webDistDir: null,
  });
  activeDaemons.push(daemon);
  await daemon.app.ready();

  const ws = daemon.store.createWorkspace({
    id: 'ws_np12',
    name: 'NP12 Tasks WS',
    rootPath: tmp,
    isGitRepo: false,
    gitBranch: null,
    createdAt: 1_000,
  });

  const session = daemon.store.createSession({
    id: 'sess_np12',
    workspaceId: ws.id,
    harnessId: 'agy',
    harnessKind: 'agy',
    nativeSessionId: 'nat_root_t09',
    cwd: tmp,
    worktreeBranch: null,
    title: 'NP-12 Goal & Schedule Test Session',
    status: 'idle',
    model: null,
    reasoningEffort: null,
    permissionMode: 'manual',
    lastSeq: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  daemon.nativeRegistry.setFeatureFlags({
    enabled: true,
    nativeLifecycle: true,
    nativePermissions: true,
    nativeCommands: true,
    observatoryTap: false,
    acpV2Preview: false,
  });

  const stored = daemon.nativeRegistry.ensureRuntimeBinding({
    sessionId: session.id,
    instanceId: 'agy',
    profileRef: 'agy:default',
    sourceRef: 'agy_cli',
    status: 'attached',
  });

  const binding: RuntimeBinding = {
    runtimeId: stored.runtimeId,
    sessionId: stored.sessionId,
    instanceId: stored.instanceId,
    generation: stored.generation,
  };

  return { daemon, session, binding };
}

describe('NP-12 Goal, Schedule & Native Tasks Observer', () => {
  it('T09: handles one-shot schedule with ended user turn, separate WorkId vs wake ActivityId, and registry commit', async () => {
    const { daemon, binding } = await createNp12DaemonEnv();
    const observer = new GoalScheduleTasksObserver({ now: () => 1_764_100_022_000 });

    const steps = loadTasksNdjsonFixture(path.join(FIXTURES_DIR, 't09-oneshot-post-turn-wake.ndjson'));
    const replay = replayTasksNdjson(observer, binding, steps, {
      rootNativeSessionId: 'nat_root_t09',
      connectionId: 'conn_t09_1',
    });

    expect(replay.scenarioMeta?.scenarioId).toBe('T09-ONESHOT-WAKE');
    expect(replay.scenarioMeta?.source).toBe('synthetic');

    const schedId = asWorkflowId('wf_sched_oneshot_1');
    const sched = observer.getScheduleSnapshot(binding, schedId);
    expect(sched).not.toBeNull();
    expect(sched?.scheduleKind).toBe('one_shot');
    expect(sched?.blocksUserTurn).toBe(false);
    expect(sched?.timezone).toMatchObject({ kind: 'known', value: 'Asia/Shanghai' });
    expect(sched?.nextAt).toMatchObject({ kind: 'known', value: 1_764_100_020_000 });
    expect(sched?.nextAtSource).toBe('native_wire_timestamp');
    expect(sched?.occurrences).toHaveLength(1);

    const occ = sched!.occurrences[0]!;
    expect(occ.workId).toMatch(/^wrk_occ_/);
    expect(occ.hasObservedWake).toBe(true);
    expect(occ.latestWakeActivityId).toMatch(/^act_wake_/);
    expect(occ.latestWakeActivityId).not.toBe(occ.workId);
    expect(occ.state).toMatchObject({ kind: 'known', value: 'finished' });
    expect(occ.outcome).toMatchObject({ kind: 'known', value: 'succeeded' });

    // Commit all batches into real SQLite-backed AgyNativeRuntimeRegistry and verify strict DTO schemas
    for (const res of replay.results) {
      observer.commitToRegistry(daemon.nativeRegistry, binding, res.commits);
    }

    const projection = daemon.nativeRegistry.getProjectionForSession(binding.sessionId, binding.instanceId);
    const wf = projection.workflows.find((w) => w.id === schedId);
    expect(wf).toBeDefined();
    expect(NativeWorkflowDtoSchema.parse(wf)).toBeDefined();
    expect(wf?.detail.kind).toBe('schedule');
    if (wf?.detail.kind === 'schedule') {
      expect(wf.detail.occurrenceWorkIds).toEqual([occ.workId]);
    }
    const wakeAct = projection.activities.find((a) => a.id === occ.latestWakeActivityId);
    expect(wakeAct).toBeDefined();
    expect(wakeAct?.turnId).toBeNull();
    expect(wakeAct?.origin).toBe('native_task');
    expect(wakeAct?.workId).toBe(occ.workId);
  });

  it('T09: covers Goal launch, verification artifacts (rejecting host paths), Goal replacement, Stop, and early schedule cancel', () => {
    const binding: RuntimeBinding = {
      runtimeId: 'rt_np12_goal' as RuntimeBinding['runtimeId'],
      sessionId: 'sess_goal',
      instanceId: 'agy',
      generation: asBindingGeneration('gen_1'),
    };
    const observer = new GoalScheduleTasksObserver({ now: () => 1_764_100_120_000 });
    const steps = loadTasksNdjsonFixture(
      path.join(FIXTURES_DIR, 't09-early-cancel-and-goal-lifecycle.ndjson'),
    );
    const replay = replayTasksNdjson(observer, binding, steps, {
      rootNativeSessionId: 'nat_root_t09',
      connectionId: 'conn_t09_2',
    });

    const oldGoalId = asWorkflowId('wf_goal_1');
    const newGoalResult = replay.results[2]!;
    const newGoalId = newGoalResult.workflowId!;
    expect(newGoalId).toBeDefined();

    const oldGoal = observer.getGoalSnapshot(binding, oldGoalId)!;
    const newGoal = observer.getGoalSnapshot(binding, newGoalId)!;
    expect(oldGoal.lifecyclePhase).toBe('superseded');
    expect(oldGoal.supersededByGoalId).toBe(newGoalId);
    expect(oldGoal.verificationArtifactIds).toEqual(['art_goal_check_1']);
    expect(
      observer.getDiagnostics().some((d) => d.code === 'unapproved_artifact_rejected'),
    ).toBe(true);
    expect(newGoal.replacedGoalId).toBe(oldGoalId);
    expect(newGoal.state).toMatchObject({ kind: 'known', value: 'running' });

    // Lease is held while active Goal is running
    expect(observer.listRetentionReasons(binding)).toContain(`goal_active:${newGoalId}`);

    // Request Goal stop (requested != confirmed until native cancelled frame arrives)
    observer.recordGoalStopRequested(binding, newGoalId, 1_764_100_121_000);
    expect(observer.getGoalSnapshot(binding, newGoalId)?.stop.state).toBe('requested');
    expect(observer.listRetentionReasons(binding)).toContain(`goal_stop_grace:${newGoalId}`);

    // Native cancelled confirmation arrives
    observer.acceptFrame({
      binding,
      connectionId: 'conn_t09_2',
      ingressOrdinal: 99,
      channel: 'live',
      originSession: 'nat_root_t09',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_root_t09',
          update: {
            sessionUpdate: 'goal_update',
            status: 'cancelled',
            goal: { goalId: 'nat_goal_2' },
          },
        },
      },
    });
    const confirmedGoal = observer.getGoalSnapshot(binding, newGoalId)!;
    expect(confirmedGoal.stop.state).toBe('confirmed');
    expect(confirmedGoal.state).toMatchObject({ kind: 'known', value: 'cancelled' });

    // Early cancelled schedule transitions to cancelled and preserves history
    const cancelledSched = observer.getScheduleSnapshot(
      binding,
      asWorkflowId('wf_sched_early_cancel'),
    )!;
    expect(cancelledSched.lifecyclePhase).toBe('cancelled');
    expect(cancelledSched.state).toMatchObject({ kind: 'known', value: 'cancelled' });
    expect(observer.listRetentionReasons(binding)).toEqual([]);
  });

  it('T09: simulates multi-occurrence cron without guessing nextAt or host timezone', () => {
    const binding: RuntimeBinding = {
      runtimeId: 'rt_np12_cron' as RuntimeBinding['runtimeId'],
      sessionId: 'sess_cron',
      instanceId: 'agy',
      generation: asBindingGeneration('gen_1'),
    };
    const observer = new GoalScheduleTasksObserver({ now: () => 1_764_100_225_000 });
    const steps = loadTasksNdjsonFixture(
      path.join(FIXTURES_DIR, 't09-simulated-cron-multi-occurrence.ndjson'),
    );
    replayTasksNdjson(observer, binding, steps, {
      rootNativeSessionId: 'nat_root_t09',
      connectionId: 'conn_t09_3',
    });

    const sched = observer.getScheduleSnapshot(binding, asWorkflowId('wf_sched_cron_1'))!;
    expect(sched.scheduleKind).toBe('cron');
    expect(sched.cronExpression).toBe('*/5 * * * *');
    expect(sched.nextAt).toMatchObject({ kind: 'unknown', reasonCode: 'native_next_at_not_exposed' });
    expect(sched.nextAtSource).toBe('not_exposed');
    expect(sched.timezone).toMatchObject({ kind: 'unknown', reasonCode: 'native_timezone_not_exposed' });
    expect(sched.occurrences).toHaveLength(2);
    expect(sched.occurrences[0]!.workId).not.toBe(sched.occurrences[1]!.workId);
    expect(sched.occurrences[0]!.latestWakeActivityId).not.toBe(
      sched.occurrences[1]!.latestWakeActivityId,
    );
    // Idle cron must NOT hold an unproven retention lease
    expect(observer.listRetentionReasons(binding)).toEqual([]);
  });

  it('T14: handles disconnect stale marking, preserves expired history, and reconciles NP-15 recovery safely', () => {
    const binding1: RuntimeBinding = {
      runtimeId: 'rt_np12_t14' as RuntimeBinding['runtimeId'],
      sessionId: 'sess_t14',
      instanceId: 'agy',
      generation: asBindingGeneration('gen_1'),
    };
    const observer = new GoalScheduleTasksObserver({ now: () => 1_764_100_330_000 });
    const steps = loadTasksNdjsonFixture(
      path.join(FIXTURES_DIR, 't14-disconnect-restart-recovery.ndjson'),
    );
    replayTasksNdjson(observer, binding1, steps, {
      rootNativeSessionId: 'nat_root_t14',
      connectionId: 'conn_t14_1',
    });

    const schedId = asWorkflowId('wf_sched_t14');
    const afterDisconnect = observer.getScheduleSnapshot(binding1, schedId)!;
    expect(afterDisconnect.state.kind).toBe('stale');
    expect(afterDisconnect.occurrences[0]!.recoveryState).toBe('preserved_read_only');
    expect(afterDisconnect.occurrences[0]!.state).toMatchObject({ kind: 'known', value: 'finished' });
    expect(afterDisconnect.occurrences[1]!.recoveryState).toBe('stale_unconfirmed');
    expect(afterDisconnect.occurrences[1]!.state.kind).toBe('stale');

    // Cross-profile / cross-workspace recovery MUST be blocked (no rebinding existing user tasks)
    const binding2: RuntimeBinding = {
      ...binding1,
      generation: asBindingGeneration('gen_2'),
    };
    const priorEvidence = observer.getRecoveryPort().listEvidenceForRuntime(binding1.runtimeId);
    const blocked = observer.reconcileRecovery({
      nextBinding: binding2,
      scopeCheck: {
        profileMatches: false,
        sourceMatches: true,
        workspaceMatches: true,
        conversationIdMatches: true,
      },
      priorEvidence,
      nowMs: 1_764_100_340_000,
    });
    expect(blocked.accepted).toBe(false);
    expect(blocked.reasonCode).toBe('cross_scope_rebind_blocked');

    // Matching scope recovery deduplicates duplicate occurrence evidence and grants no speculative lease
    const duplicateEvidence = [...priorEvidence, ...priorEvidence];
    const reconciled = observer.reconcileRecovery({
      nextBinding: binding2,
      scopeCheck: {
        profileMatches: true,
        sourceMatches: true,
        workspaceMatches: true,
        conversationIdMatches: true,
      },
      priorEvidence: duplicateEvidence,
      nowMs: 1_764_100_345_000,
    });
    expect(reconciled.accepted).toBe(true);
    expect(reconciled.deduplicatedCount).toBeGreaterThan(0);
    expect(reconciled.leaseJustified).toBe(false);

    const recoveredSched = observer.getScheduleSnapshot(binding2, schedId)!;
    expect(recoveredSched).not.toBeNull();
    expect(recoveredSched.occurrences).toHaveLength(2);
    expect(recoveredSched.occurrences[0]!.recoveryState).toBe('preserved_read_only');
    expect(recoveredSched.occurrences[1]!.state.kind).toBe('stale');
  });

  it('aggregates finite/daemon/schedule/goal tasks, closes App-only Automations/Sidecars, and registers NP-06 descriptors', () => {
    const binding: RuntimeBinding = {
      runtimeId: 'rt_np12_agg' as RuntimeBinding['runtimeId'],
      sessionId: 'sess_agg',
      instanceId: 'agy',
      generation: asBindingGeneration('gen_1'),
    };
    const observer = new GoalScheduleTasksObserver({ now: () => 1_764_100_400_000 });
    observer.registerBinding({
      binding,
      connectionId: 'conn_agg',
      rootNativeSessionId: 'nat_root_agg',
    });

    // Finite command + Daemon + App Automation mention
    observer.acceptFrame({
      binding,
      connectionId: 'conn_agg',
      ingressOrdinal: 1,
      channel: 'live',
      originSession: 'nat_root_agg',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_root_agg',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_fin_1',
            title: 'pnpm test',
            status: 'in_progress',
            rawInput: { isBackground: true },
          },
        },
      },
    });
    observer.acceptFrame({
      binding,
      connectionId: 'conn_agg',
      ingressOrdinal: 2,
      channel: 'live',
      originSession: 'nat_root_agg',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_root_agg',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_dae_1',
            title: 'dev server',
            status: 'in_progress',
            rawInput: { IsDaemon: true },
          },
        },
      },
    });

    const autoRes = observer.acceptFrame({
      binding,
      connectionId: 'conn_agg',
      ingressOrdinal: 3,
      channel: 'live',
      originSession: 'nat_root_agg',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_root_agg',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_auto_1',
            toolName: 'automation',
            title: '/automation daily report',
            status: 'in_progress',
          },
        },
      },
    });
    expect(autoRes.accepted).toBe(false);
    expect(autoRes.diagnostic?.code).toBe('app_only_automation_closed');

    const externalWork: NativeWork = {
      id: asWorkId('wrk_ext_1'),
      kind: 'unknown',
      blocking: 'unknown',
      state: { kind: 'unknown', reasonCode: 'not_classified' },
      revision: 1,
    };

    const center = observer.getTasksCenterSnapshot(binding, [externalWork]);
    expect(center.countsByCategory.finite_command).toBe(1);
    expect(center.countsByCategory.daemon).toBe(1);
    expect(center.countsByCategory.unknown).toBe(1);
    expect(center.countsByCategory.schedule).toBe(0);
    expect(center.protocolExposure).toEqual(TASKS_PROTOCOL_EXPOSURE_ASSESSMENT);
    expect(center.appAutomationsClosure).toEqual(APP_AUTOMATIONS_CLOSURE_RECORD);
    expect(TASKS_WIRE_FIELD_VERSIONS.length).toBeGreaterThanOrEqual(6);

    const catalog = new AgyNativeCommandCatalogService();
    const dispose = registerTasksCapabilityDescriptors(catalog);
    const snap = catalog.updateBindingSignals(binding, {
      profileRef: 'agy:default',
      profileVerified: true,
      hasLiveConnection: true,
      advertisedCommands: [{ name: 'goal' }, { name: 'schedule' }, { name: 'tasks' }],
    }).snapshot;
    expect(snap.descriptors.find((d) => d.id === 'AGY-W12')?.launch).toBe('unsupported');
    expect(snap.descriptors.find((d) => d.id === 'AGY-W11')?.id).toBe('AGY-W11');
    dispose();
  });

  it('enforces G3-04/G3-05 fencing (stale generation, wrong connection, history_replay isolation) and read-only rollback', () => {
    const binding1: RuntimeBinding = {
      runtimeId: 'rt_fence' as RuntimeBinding['runtimeId'],
      sessionId: 'sess_fence',
      instanceId: 'agy',
      generation: asBindingGeneration('gen_1'),
    };
    const binding2: RuntimeBinding = {
      ...binding1,
      generation: asBindingGeneration('gen_2'),
    };
    const observer = new GoalScheduleTasksObserver({ now: () => 1_764_100_500_000 });
    observer.registerBinding({
      binding: binding1,
      connectionId: 'conn_1',
      rootNativeSessionId: 'nat_root_f',
    });

    const schedLaunch = observer.recordConfirmedScheduleLaunch({
      binding: binding1,
      connectionId: 'conn_1',
      originActivityId: asActivityId('act_f_1'),
      scheduleKind: 'one_shot',
      durationSeconds: 10,
      nativeScheduleId: 'nat_f_sched',
      workflowId: asWorkflowId('wf_f_sched'),
      observedAt: 1_764_100_500_000,
    });
    expect(schedLaunch.accepted).toBe(true);

    // history_replay frame MUST NOT mutate live state
    const replayFrame: NativeIngress = {
      binding: binding1,
      connectionId: 'conn_1',
      ingressOrdinal: 2,
      channel: 'history_replay',
      originSession: 'nat_root_f',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_root_f',
          update: {
            sessionUpdate: 'schedule_triggered',
            occurrence: { scheduleId: 'nat_f_sched', occurrenceId: 'hist_occ_1', occurrenceIndex: 1 },
          },
        },
      },
    };
    const replayRes = observer.acceptFrame(replayFrame);
    expect(replayRes.accepted).toBe(false);
    expect(replayRes.diagnostic?.code).toBe('history_replay_isolated');
    expect(observer.getScheduleSnapshot(binding1, asWorkflowId('wf_f_sched'))?.occurrences).toHaveLength(0);

    // Wrong connection rejected
    const wrongConnRes = observer.acceptFrame({
      ...replayFrame,
      channel: 'live',
      connectionId: 'conn_wrong',
    });
    expect(wrongConnRes.accepted).toBe(false);
    expect(wrongConnRes.diagnostic?.code).toBe('wrong_connection_rejected');

    // Generation replacement retires gen_1 connection
    observer.registerBinding({
      binding: binding2,
      connectionId: 'conn_2',
      rootNativeSessionId: 'nat_root_f',
    });
    const staleGenFrame = observer.acceptFrame({ ...replayFrame, channel: 'live', ingressOrdinal: 3 });
    expect(staleGenFrame.accepted).toBe(false);

    // Feature-off rollback blocks live writes while preserving read-only workflow resource access
    observer.setEnabled(false);
    const disabledLaunch = observer.recordConfirmedGoalLaunch({
      binding: binding2,
      connectionId: 'conn_2',
      originActivityId: asActivityId('act_disabled'),
      objective: 'Should not write',
    });
    expect(disabledLaunch.accepted).toBe(false);
    expect(disabledLaunch.diagnostic?.code).toBe('observer_disabled_read_only');

    const logsPage = observer.readWorkflowResource({
      binding: binding1,
      workflowId: asWorkflowId('wf_f_sched'),
      resource: 'logs',
      limit: 10,
    });
    expect(logsPage.available).toBe(true);
    expect(logsPage.items.length).toBeGreaterThan(0);

    const parsedResp = NativeWorkflowResourceResponseSchema.parse({
      schemaVersion: 1,
      binding: binding1,
      workflowId: asWorkflowId('wf_f_sched'),
      resource: 'logs',
      ...logsPage,
    });
    expect(parsedResp.items.length).toBe(logsPage.items.length);

    // Verify sanitizeNativeWorkflowForPublic & decodeTasksIngressFrame direct coverage
    const wfDto = sanitizeNativeWorkflowForPublic(
      NativeWorkflowSchema.parse({
        id: asWorkflowId('wf_f_sched'),
        originActivityId: asActivityId('act_f_1'),
        state: { kind: 'unknown', reasonCode: 'test' },
        detail: { kind: 'schedule', occurrenceWorkIds: [] },
        revision: 1,
      }),
    );
    expect(wfDto.detail.kind).toBe('schedule');

    const invalidTzDecoded = decodeTasksIngressFrame({
      binding: binding2,
      connectionId: 'conn_2',
      ingressOrdinal: 1,
      channel: 'live',
      originSession: 'nat_root_f',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_root_f',
          update: {
            sessionUpdate: 'schedule_update',
            schedule: { scheduleId: 's_tz', timezone: 'Mars/Olympus_Mons', DurationSeconds: 15 },
          },
        },
      },
    });
    expect(invalidTzDecoded.kind).toBe('schedule_upsert');
    if (invalidTzDecoded.kind === 'schedule_upsert') {
      expect(invalidTzDecoded.timezone).toBeUndefined();
      expect(invalidTzDecoded.invalidTimezoneIgnored).toBe(true);
    }
  });
});
