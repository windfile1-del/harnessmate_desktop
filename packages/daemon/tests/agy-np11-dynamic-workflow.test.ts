import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NativeWorkflowDtoSchema,
  NativeWorkflowResourceResponseSchema,
  NativeWorkflowSchema,
  WorkflowDetailDtoSchema,
  WorkflowDetailSchema,
  asActivityId,
  asBindingGeneration,
  asNativeAgentId,
  asWorkflowId,
  sanitizeNativeWorkflowForPublic,
  type NativeCanonicalEvent,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import {
  NativePermissionRouter,
  NativeRequestValidationError,
} from '../src/harnesses/agy/native/requests/index.js';
import {
  DYNAMIC_WORKFLOW_CODEC_RULES,
  DYNAMIC_WORKFLOW_DESCRIPTOR_CONTRIBUTION,
  DYNAMIC_WORKFLOW_WIRE_FIELD_VERSIONS,
  DynamicWorkflowObserver,
  FrozenDynamicWorkflowArtifactReaderStub,
  decodeDynamicWorkflowIngress,
  loadDynamicWorkflowNdjsonFixture,
  replayDynamicWorkflowNdjson,
} from '../src/harnesses/agy/native/workflows/dynamic/index.js';
import { createDaemon } from '../src/server/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'agy-np11');

const tempDirs: string[] = [];
const activeDaemons: Array<ReturnType<typeof createDaemon>> = [];
const activeRouters: NativePermissionRouter[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeRouters.length > 0) {
    activeRouters.pop()?.dispose();
  }
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

async function createNp11TestEnv(opts?: {
  permissionMode?: 'manual' | 'accept_edits';
}) {
  const tmp = makeTempDir('hm-np11-');
  const daemon = createDaemon({
    dataDir: path.join(tmp, 'data'),
    port: 0,
    webDistDir: null,
  });
  activeDaemons.push(daemon);
  await daemon.app.ready();

  const ws = daemon.store.createWorkspace({
    id: 'ws_np11',
    name: 'NP11 Dynamic Workflow WS',
    rootPath: tmp,
    isGitRepo: false,
    gitBranch: null,
    createdAt: 1_000,
  });

  const session = daemon.store.createSession({
    id: 'sess_np11',
    workspaceId: ws.id,
    harnessId: 'agy',
    harnessKind: 'agy',
    nativeSessionId: 'nat_root_t13',
    cwd: tmp,
    worktreeBranch: null,
    title: 'NP-11 Dynamic Workflow Test Session',
    status: 'idle',
    model: null,
    reasoningEffort: null,
    permissionMode: opts?.permissionMode ?? 'manual',
    lastSeq: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  daemon.nativeRegistry.setFeatureFlags({
    enabled: true,
    nativeLifecycle: true,
    nativePermissions: true,
    nativeCommands: false,
    observatoryTap: false,
    acpV2Preview: false,
  });

  const stored = daemon.nativeRegistry.ensureRuntimeBinding({
    sessionId: session.id,
    instanceId: 'agy',
    profileRef: 'agy:default',
    status: 'attached',
  });

  const binding: RuntimeBinding = {
    runtimeId: stored.runtimeId,
    sessionId: stored.sessionId,
    instanceId: stored.instanceId,
    generation: stored.generation,
  };

  return { daemon, session, binding, tmp };
}

describe('NP-11 Dynamic Workflows Observer, Artifacts, and 1.5.16 Question Forwarding', () => {
  it('replays T13 parallel vs serial non-mutating workflows, validates strict dynamic schemas, holds/releases retention, and publishes to registry', async () => {
    const { daemon, binding } = await createNp11TestEnv();
    const observer = new DynamicWorkflowObserver();
    observer.registerRootSession(binding, 'nat_root_t13');

    const entries = loadDynamicWorkflowNdjsonFixture(
      path.join(FIXTURES_DIR, 't13-parallel-serial-comparison.ndjson'),
    );
    const replay = replayDynamicWorkflowNdjson(observer, binding, entries, {
      rootNativeSessionId: 'nat_root_t13',
    });

    expect(replay.scenarioMeta?.scenarioId).toBe('T13-PARALLEL-SERIAL');
    expect(replay.results).toHaveLength(6);

    // Retention is held while parallel steps are running (before completion frame #4)
    // Re-check intermediate retention using a second isolated observer up to frame 2
    const midObserver = new DynamicWorkflowObserver();
    midObserver.registerRootSession(binding, 'nat_root_t13');
    replayDynamicWorkflowNdjson(midObserver, binding, entries.slice(0, 3), {
      rootNativeSessionId: 'nat_root_t13',
    });
    const midRetention = midObserver.listRetentionReasons(binding);
    expect(midRetention.some((r) => r.startsWith('dynamic_workflow_step:'))).toBe(true);

    // After completion of both parallel and serial runs, retention is cleanly released
    expect(observer.listRetentionReasons(binding)).toEqual([]);

    const snapshots = observer.listObservedWorkflowSnapshots(binding);
    expect(snapshots).toHaveLength(2);

    const parallelSnap = snapshots.find((s) => s.workflowId.includes('dyn_par_01'));
    const serialSnap = snapshots.find((s) => s.workflowId.includes('dyn_ser_02'));
    expect(parallelSnap).toBeDefined();
    expect(serialSnap).toBeDefined();

    // Parallel run has verified DAG (2 parallel nodes -> 1 serial summary node)
    expect(parallelSnap!.hasVerifiedDag).toBe(true);
    expect(parallelSnap!.steps.map((s) => s.id)).toEqual([
      'step_lint_ro',
      'step_schema_ro',
      'step_summary_ro',
    ]);
    expect(parallelSnap!.steps[0]!.executionMode).toBe('parallel');
    expect(parallelSnap!.steps[2]!.after).toEqual(['step_lint_ro', 'step_schema_ro']);

    // Serial baseline has verified serial edge ser_1 -> ser_2
    expect(serialSnap!.hasVerifiedDag).toBe(true);
    expect(serialSnap!.steps.map((s) => s.id)).toEqual(['ser_1', 'ser_2']);
    expect(serialSnap!.steps[1]!.after).toEqual(['ser_1']);

    // ScriptPath is redacted and never read from disk; inline Script preview is read-only
    expect(parallelSnap!.scriptPreview?.rawPathRedacted).toBe(true);
    expect(parallelSnap!.scriptPreview?.previewLines.join('\n')).toContain('parallel');
    expect(JSON.stringify(parallelSnap)).not.toContain('C:\\private\\unapproved');

    // Structured JSON results parsed safely
    expect(parallelSnap!.resultSummaries.length).toBeGreaterThanOrEqual(3);
    expect(
      parallelSnap!.resultSummaries.some(
        (r) => r.format === 'json_object' && r.topLevelKeys?.includes('passed'),
      ),
    ).toBe(true);

    // Validate strict Zod protocol schemas
    const wfParsed = NativeWorkflowSchema.parse(parallelSnap!.workflow);
    WorkflowDetailSchema.parse(wfParsed.detail);
    const wfDto = sanitizeNativeWorkflowForPublic(wfParsed, 1_764_100_005_000);
    NativeWorkflowDtoSchema.parse(wfDto);
    WorkflowDetailDtoSchema.parse(wfDto.detail);

    // Commit batches to AgyNativeRuntimeRegistry + verify SQLite projection persistence
    const published: NativeCanonicalEvent[] = [];
    daemon.nativeRegistry.subscribeSession(binding.sessionId, (ev) => published.push(ev));
    for (const res of replay.results) {
      observer.commitToRegistry(daemon.nativeRegistry, binding, res.commits);
    }

    const projection = daemon.nativeRegistry.getProjectionForSession(
      binding.sessionId,
      binding.instanceId,
    );
    expect(projection.workflows).toHaveLength(2);
    expect(projection.workflows.every((w) => w.detail.kind === 'dynamic')).toBe(true);
    expect(published.some((e) => e.type === 'native.workflow.changed')).toBe(true);
  });

  it('handles denied scripts, node failure with partial results, missing edges (no Python inference), and partial omitted-field patches', async () => {
    const { daemon, binding } = await createNp11TestEnv();
    const observer = new DynamicWorkflowObserver();
    observer.registerRootSession(binding, 'nat_root_t13_2');

    const router = new NativePermissionRouter(daemon.nativeRegistry, {
      targetResolver: {
        getRootNativeSessionId: () => 'nat_root_t13_2',
        resolveTarget: (input) =>
          observer.resolveRequestTarget(input) ?? {
            scope: 'root',
            targetLineage: 'confirmed',
            turnId: null,
            isDetached: true,
            forwardedToParentSession: false,
            provenanceReason: 'fallback_root',
          },
      },
    });
    activeRouters.push(router);

    const entries = loadDynamicWorkflowNdjsonFixture(
      path.join(FIXTURES_DIR, 't13-denied-partial-and-missing-fields.ndjson'),
    );

    // Frame 1: denied workflow triggered
    const f1 = observer.acceptFrame(
      {
        binding,
        connectionId: entries[1]!.connectionId!,
        ingressOrdinal: entries[1]!.ingressOrdinal!,
        channel: 'live',
        originSession: entries[1]!.originSession,
        wire: entries[1]!.frame,
      },
      {
        originActivityId: asActivityId('act_t13_denied'),
        turnId: 'turn_t13_denied',
        rootNativeSessionId: 'nat_root_t13_2',
        nowMs: entries[1]!.nowMs,
      },
    );
    const deniedWfId = f1.workflowIds[0]!;

    // Frame 2: server request for script approval routed through NP-07
    const f2Frame = entries[2]!.frame as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    const f2Obs = observer.acceptFrame(
      {
        binding,
        connectionId: entries[2]!.connectionId!,
        ingressOrdinal: entries[2]!.ingressOrdinal!,
        channel: 'live',
        originSession: entries[2]!.originSession,
        wire: f2Frame,
      },
      {
        originActivityId: asActivityId('act_t13_denied'),
        turnId: 'turn_t13_denied',
        rootNativeSessionId: 'nat_root_t13_2',
        nowMs: entries[2]!.nowMs,
      },
    );
    expect(f2Obs.pendingRequestHint?.workflowId).toBe(deniedWfId);

    const wireReplies: unknown[] = [];
    const reqDecision = router.onIncomingRequest({
      binding,
      connectionId: 'conn_t13_2',
      ingressOrdinal: 2,
      channel: 'live',
      wireRequestId: f2Frame.id,
      method: f2Frame.method,
      params: f2Frame.params,
      respond: (res) => {
        wireReplies.push(res);
        return true;
      },
      respondError: () => true,
    });
    expect(reqDecision?.handled).toBe(true);

    const pending = router.listPendingRequests(binding);
    expect(pending).toHaveLength(1);
    const approvalId = pending[0]!.approvalId;
    observer.onWorkflowRequestObserved({
      binding,
      workflowId: deniedWfId,
      approvalId,
      isScriptApproval: true,
      isInteractionQuestion: false,
    });
    expect(observer.listRetentionReasons(binding)).toContain(
      `dynamic_workflow_request:${approvalId}`,
    );

    // User denies the script via NP-07 CAS
    const outcome = await router.resolveWithCas({
      binding,
      approvalId,
      request: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'reject_once',
        idempotencyKey: 'deny-script-1',
      },
      resolvedBy: 'desktop',
    });
    expect(outcome.receiptState).toBe('response_written');
    expect(wireReplies).toEqual([{ outcome: { outcome: 'selected', optionId: 'reject_once' } }]);

    const cancelledWf = observer.onWorkflowRequestResolved({
      binding,
      workflowId: deniedWfId,
      approvalId,
      receiptState: outcome.receiptState,
      selectedOptionId: 'reject_once',
    });
    expect(cancelledWf?.state.kind).toBe('known');
    if (cancelledWf?.state.kind === 'known') {
      expect(cancelledWf.state.value).toBe('cancelled');
    }

    const deniedSnap = observer.getObservedWorkflowSnapshot(binding, deniedWfId)!;
    expect(deniedSnap.lifecyclePhase).toBe('script_denied');
    expect(deniedSnap.scriptPreview?.approvalState).toBe('denied');
    expect(deniedSnap.scriptPreview?.rawPathRedacted).toBe(true);
    expect(observer.listRetentionReasons(binding)).toEqual([]);

    // Now replay remaining frames (partial failure + missing `after` edges + omitted status patch)
    replayDynamicWorkflowNdjson(observer, binding, entries.slice(3), {
      rootNativeSessionId: 'nat_root_t13_2',
    });

    const partialWfId = asWorkflowId('wf_dyn_dyn_partial_02');
    const partialSnap = observer.getObservedWorkflowSnapshot(binding, partialWfId)!;
    expect(partialSnap).toBeDefined();

    // Script text contains `parallel(step_a, step_b)` — observer MUST NOT parse Python to fake a DAG
    expect(partialSnap.hasVerifiedDag).toBe(false);
    expect(partialSnap.dagUnavailableReason).toBe('no_dependency_edges_observed');

    expect(partialSnap.lifecyclePhase).toBe('partial_results');
    const stepA = partialSnap.steps.find((s) => s.id === 'step_a')!;
    const stepB = partialSnap.steps.find((s) => s.id === 'step_b')!;
    // Omitted status on frame #6 preserved `finished` for step_a
    expect(stepA.state).toMatchObject({ kind: 'known', value: 'finished' });
    expect(stepA.outcome).toMatchObject({ kind: 'known', value: 'succeeded' });
    expect(stepB.state).toMatchObject({ kind: 'known', value: 'failed' });
    expect(stepB.outcome).toMatchObject({ kind: 'known', value: 'failed' });
    expect(stepB.errorSummary).toContain('step B non-zero failure');
    expect(partialSnap.resultSummaries.some((r) => r.artifactId === 'art_partial_a')).toBe(true);
  });

  it('enforces independent AGY 1.5.16 question forwarding assertions (accept-edits no auto-approve, numeric vs string RpcId, parent session preservation, no free-text)', async () => {
    const { daemon, binding } = await createNp11TestEnv({
      permissionMode: 'accept_edits',
    });
    const observer = new DynamicWorkflowObserver();
    observer.registerRootSession(binding, 'nat_root_1516');

    const router = new NativePermissionRouter(daemon.nativeRegistry, {
      targetResolver: {
        getRootNativeSessionId: () => 'nat_root_1516',
        resolveTarget: (input) =>
          observer.resolveRequestTarget(input) ?? {
            scope: 'root',
            targetLineage: 'confirmed',
            turnId: null,
            isDetached: false,
            forwardedToParentSession: false,
            provenanceReason: 'fallback_root',
          },
      },
    });
    activeRouters.push(router);

    const entries = loadDynamicWorkflowNdjsonFixture(
      path.join(FIXTURES_DIR, 't13-1516-question-forwarding.ndjson'),
    );

    const replies: Array<{ rpcId: unknown; payload: unknown }> = [];
    for (const entry of entries) {
      if (entry.kind !== 'wire_frame' || !entry.frame) continue;
      const envelope = {
        binding,
        connectionId: entry.connectionId!,
        ingressOrdinal: entry.ingressOrdinal!,
        channel: 'live' as const,
        originSession: entry.originSession,
        wire: entry.frame,
      };
      const ingest = observer.acceptFrame(envelope, {
        originActivityId: asActivityId(entry.originActivityId!),
        turnId: entry.turnId ?? null,
        rootNativeSessionId: 'nat_root_1516',
        nowMs: entry.nowMs,
      });

      const wire = entry.frame as {
        id?: string | number;
        method: string;
        params: Record<string, unknown>;
      };
      if (wire.id !== undefined) {
        const rpcId = wire.id;
        router.onIncomingRequest({
          binding,
          connectionId: entry.connectionId!,
          ingressOrdinal: entry.ingressOrdinal!,
          channel: 'live',
          wireRequestId: rpcId,
          method: wire.method,
          params: wire.params,
          respond: (result) => {
            replies.push({ rpcId, payload: result });
            return true;
          },
          respondError: () => true,
        });
        expect(ingest.pendingRequestHint).toBeDefined();
      }
    }

    // In `accept_edits`, neither 1.5.16 forwarded workflow question may be auto-approved!
    expect(replies).toHaveLength(0);
    const pending = router.listPendingRequests(binding);
    const details = router.listRequestDetails(binding);
    expect(pending).toHaveLength(2);
    expect(details).toHaveLength(2);

    const numReq = details.find((d) => d.toolName === 'interaction' && d.allowedOptionIds.includes('docs_only'))!;
    const strReq = details.find((d) => d.toolName === 'interaction' && d.allowedOptionIds.includes('json_summary'))!;
    const numPending = pending.find((p) => p.approvalId === numReq.approvalId)!;
    const strPending = pending.find((p) => p.approvalId === strReq.approvalId)!;

    // Exact AGY 1.5.16 forwarding & RpcId type fidelity assertions
    expect(typeof numPending.wireRequestId).toBe('number');
    expect(numPending.wireRequestId).toBe(8801);
    expect(typeof strPending.wireRequestId).toBe('string');
    expect(strPending.wireRequestId).toBe('wf-1516-str-8802');

    expect(numPending.actualNativeSessionId).toBe('nat_root_1516');
    expect(strPending.actualNativeSessionId).toBe('nat_root_1516');
    expect(numReq.scope).toBe('confirmed_workflow');
    expect(numReq.workflowKind).toBe('dynamic');
    expect(numReq.forwardedToParentSession).toBe(true);
    expect(strReq.forwardedToParentSession).toBe(true);
    expect(numReq.allowsFreeText).toBe(false);
    expect(strReq.allowsFreeText).toBe(false);

    // Reject free-text / form fabrication on fixed-option 1.5.16 questions
    await expect(
      router.resolveWithCas({
        binding,
        approvalId: numReq.approvalId,
        request: {
          generation: binding.generation,
          outcome: 'form_submitted',
          formPayload: { answer: 'fabricated' },
          idempotencyKey: 'bad-free-text-1',
        },
        resolvedBy: 'desktop',
      }),
    ).rejects.toThrow(NativeRequestValidationError);

    // Resolve both in reverse order and confirm exact RpcId types & optionIds
    const rStr = await router.resolveWithCas({
      binding,
      approvalId: strReq.approvalId,
      request: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'markdown_report',
        idempotencyKey: 'resolve-str-1516',
      },
      resolvedBy: 'desktop',
    });
    const rNum = await router.resolveWithCas({
      binding,
      approvalId: numReq.approvalId,
      request: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'docs_only',
        idempotencyKey: 'resolve-num-1516',
      },
      resolvedBy: 'desktop',
    });

    expect(rStr.receiptState).toBe('response_written');
    expect(rNum.receiptState).toBe('response_written');
    expect(replies).toEqual([
      {
        rpcId: 'wf-1516-str-8802',
        payload: { outcome: { outcome: 'selected', optionId: 'markdown_report' } },
      },
      {
        rpcId: 8801,
        payload: { outcome: { outcome: 'selected', optionId: 'docs_only' } },
      },
    ]);
  });

  it('rejects unapproved artifact paths, paginates large logs & JSON results safely, and enforces replay/disconnect/disable invariants', async () => {
    const { binding } = await createNp11TestEnv();
    const artifactStub = new FrozenDynamicWorkflowArtifactReaderStub();
    const observer = new DynamicWorkflowObserver({ artifactReader: artifactStub });
    const wfId = asWorkflowId('wf_dyn_dyn_big_01');

    // Ingest trigger + large JSON array + multiple logs
    observer.acceptFrame(
      {
        binding,
        connectionId: 'conn_big',
        ingressOrdinal: 1,
        channel: 'live',
        originSession: 'nat_root_big',
        wire: {
          method: 'session/update',
          params: {
            sessionId: 'nat_root_big',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'run_workflow_big',
              toolName: 'run_workflow',
              status: 'in_progress',
              rawInput: {
                workflowId: 'dyn_big_01',
                workflowKind: 'dynamic',
                Script: 'line1\n'.repeat(120),
                ScriptPath: 'C:\\Users\\secret\\private.py',
              },
            },
          },
        },
      },
      { nowMs: 2_000 },
    );

    const largeItems = Array.from({ length: 75 }, (_, i) => ({ index: i, ok: true }));
    observer.acceptFrame(
      {
        binding,
        connectionId: 'conn_big',
        ingressOrdinal: 2,
        channel: 'live',
        originSession: 'nat_root_big',
        wire: {
          method: 'session/update',
          params: {
            sessionId: 'nat_root_big',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'run_workflow_big',
              workflowId: 'dyn_big_01',
              workflowKind: 'dynamic',
              steps: [
                {
                  id: 's1',
                  label: 'Step 1',
                  status: 'running',
                  rawOutput: { log: 'log line 1', structuredOutput: largeItems },
                  resultArtifactId: 'art_big_json',
                },
                {
                  id: 's2',
                  label: 'Step 2',
                  status: 'running',
                  rawOutput: { log: 'log line 2' },
                },
                {
                  id: 's3',
                  label: 'Step 3',
                  status: 'running',
                  rawOutput: { log: 'log line 3' },
                },
              ],
            },
          },
        },
      },
      { nowMs: 3_000 },
    );

    // Unapproved paths MUST be rejected
    for (const unsafe of [
      'C:\\Users\\secret\\private.py',
      '../outside.py',
      'file:///D:/secret.json',
      'unregistered_artifact_99',
    ]) {
      const deniedScript = artifactStub.readScriptPreview({
        binding,
        workflowId: wfId,
        artifactId: unsafe,
      });
      expect(deniedScript.ok).toBe(false);
      if (!deniedScript.ok) expect(deniedScript.errorCode).toBe('UNAPPROVED_ARTIFACT_SCOPE');

      const deniedRes = artifactStub.readStructuredResult({
        binding,
        workflowId: wfId,
        artifactId: unsafe,
      });
      expect(deniedRes.ok).toBe(false);
      if (!deniedRes.ok) expect(deniedRes.errorCode).toBe('UNAPPROVED_ARTIFACT_SCOPE');
    }

    // Approved JSON array paginates cleanly
    const page1 = artifactStub.readStructuredResult({
      binding,
      workflowId: wfId,
      artifactId: 'art_big_json',
      limit: 50,
    });
    expect(page1.ok).toBe(true);
    if (page1.ok) {
      expect(page1.items).toHaveLength(50);
      expect(page1.totalItems).toBe(75);
      expect(page1.hasMore).toBe(true);
      const page2 = artifactStub.readStructuredResult({
        binding,
        workflowId: wfId,
        artifactId: 'art_big_json',
        pageToken: page1.nextPageToken!,
        limit: 50,
      });
      expect(page2.ok).toBe(true);
      if (page2.ok) {
        expect(page2.items).toHaveLength(25);
        expect(page2.hasMore).toBe(false);
      }
    }

    // Resource reader pagination for logs, artifacts, phases, and board unavailable
    const logPage1 = observer.readWorkflowResource({
      binding,
      workflowId: wfId,
      resource: 'logs',
      limit: 2,
    });
    expect(logPage1.available).toBe(true);
    expect(logPage1.items).toHaveLength(2);
    expect(logPage1.hasMore).toBe(true);
    NativeWorkflowResourceResponseSchema.parse({
      schemaVersion: 1,
      binding,
      workflowId: wfId,
      resource: 'logs',
      ...logPage1,
    });

    const boardRes = observer.readWorkflowResource({
      binding,
      workflowId: wfId,
      resource: 'board',
      limit: 10,
    });
    expect(boardRes.available).toBe(false);
    expect(boardRes.sourceUnavailableReason).toBe('dynamic_workflow_board_not_applicable');

    // Transport close marks running workflow stale (never finished/succeeded) and releases retention
    expect(observer.listRetentionReasons(binding).length).toBeGreaterThan(0);
    const staleWfs = observer.handleTransportClosed(binding, 'conn_big', 'process_exited');
    expect(staleWfs).toHaveLength(1);
    expect(staleWfs[0]!.state.kind).toBe('stale');
    expect(observer.listRetentionReasons(binding)).toEqual([]);

    // Link confirmed child agent works cleanly when passed confirmed ID
    const childId = asNativeAgentId('ag_confirmed_worker');
    observer.linkConfirmedChildAgent({
      binding,
      workflowId: wfId,
      stepId: 's1',
      agentId: childId,
    });
    expect(
      observer.getObservedWorkflowSnapshot(binding, wfId)?.steps[0]?.agentIds,
    ).toEqual([childId]);

    // Disabling feature gate stops new mutations while preserving observed workflow & approved artifacts
    observer.setEnabled(false);
    const ignored = observer.acceptFrame({
      binding,
      connectionId: 'conn_big',
      ingressOrdinal: 99,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_root_big',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'run_workflow_after_off',
            toolName: 'run_workflow',
            status: 'in_progress',
          },
        },
      },
    });
    expect(ignored.ignoredDisabled).toBe(true);
    expect(observer.getObservedWorkflowSnapshot(binding, wfId)).not.toBeNull();
    expect(
      artifactStub.isApprovedArtifactId(binding, wfId, 'art_big_json'),
    ).toBe(true);

    // History replay isolation check + strict mode check
    const replayObs = new DynamicWorkflowObserver();
    const rep = replayObs.acceptFrame({
      binding,
      connectionId: 'conn_rep',
      ingressOrdinal: 1,
      channel: 'history_replay',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_rep',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'run_workflow_rep',
            toolName: 'run_workflow',
            status: 'in_progress',
          },
        },
      },
    });
    expect(rep.accepted).toBe(true);
    expect(replayObs.listRetentionReasons(binding)).toEqual([]);

    const strictUnknown = decodeDynamicWorkflowIngress(
      {
        binding,
        connectionId: 'conn_strict',
        ingressOrdinal: 1,
        channel: 'live',
        wire: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'plain_tool_1',
              title: 'Bash',
            },
          },
        },
      },
      { strictMode: true },
    );
    expect(strictUnknown.kind).toBe('not_dynamic_workflow');

    // Version & descriptor metadata checks
    expect(DYNAMIC_WORKFLOW_CODEC_RULES.length).toBeGreaterThanOrEqual(4);
    expect(DYNAMIC_WORKFLOW_WIRE_FIELD_VERSIONS.some((f) => f.minCliVersion === '1.5.16')).toBe(
      true,
    );
    expect(DYNAMIC_WORKFLOW_DESCRIPTOR_CONTRIBUTION.capabilityId).toBe('AGY-W08');
    expect(DYNAMIC_WORKFLOW_DESCRIPTOR_CONTRIBUTION.launchGateOverride).toBe('not_tested');
  });
});
