import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  asBindingGeneration,
  asRuntimeId,
  asWorkflowId,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isAllowedArtifactExtension,
  isSafeArtifactSegment,
  listAgySessionArtifacts,
  readAgySessionArtifact,
} from '../src/harnesses/agy/agy-artifacts.js';
import {
  AgyNativeArtifactService,
  AgyPlanDiffBrowserObserver,
  NP14_CAPABILITY_CONTRIBUTIONS,
  containsRawHostPath,
  createSyntheticVerifiedReviewTransport,
  loadNp14NdjsonFixture,
  redactSensitiveContent,
  resolveNp14FixturePath,
  toNativeIngressEnvelopes,
} from '../src/harnesses/agy/native/artifacts/index.js';
import { AgyTeamworkWorkflowObserver } from '../src/harnesses/agy/native/workflows/teamwork/observer.js';
import { DynamicWorkflowObserver } from '../src/harnesses/agy/native/workflows/dynamic/observer.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, prefix));
  tempDirs.push(dir);
  return dir;
}

function makeBinding(gen = 'gen_1', runtimeId = 'rt_np14_1'): RuntimeBinding {
  return {
    runtimeId: asRuntimeId(runtimeId),
    sessionId: 'sess_np14_1',
    instanceId: 'agy',
    generation: asBindingGeneration(gen),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('NP-14 · Suite 1: Managed Brain Artifacts, Path Boundaries, Junction Escape & Redaction (T16)', () => {
  it('enforces strict segment/extension allowlists, blocks Windows junction escape & binary NULs, and redacts secrets/paths', () => {
    const root = makeTempDir('hm-np14-brain-');
    const appDataPath = path.join(root, 'app-data');
    const outsideDir = path.join(root, 'outside-secret');
    const nativeSessId = 'native_sess_t16';
    const brainSessDir = path.join(appDataPath, 'brain', nativeSessId);

    fs.mkdirSync(brainSessDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // Valid allowed artifacts
    fs.writeFileSync(
      path.join(brainSessDir, 'implementation_plan.md'),
      [
        '# Plan',
        'Workspace path: D:\\SecretUser\\repo\\app.ts',
        'OAuth leak: https://accounts.example/cb?code=secret_oauth_code_123&state=xyz',
        'Header: Bearer ya29.a0AfB_secret_token_9999999999',
        '<script>alert("xss")</script>',
        '[Evil](https://evil.example/phish)',
        '![Tracker](https://evil.example/pixel.png)',
        '[Official](https://antigravity.google/docs/artifact-review/)',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(brainSessDir, 'patch.diff'),
      '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      'utf8',
    );
    // Valid PNG header
    fs.writeFileSync(
      path.join(brainSessDir, 'browser_preview.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    );
    // Forbidden extensions / hidden / binary-with-NUL / SVG
    fs.writeFileSync(path.join(brainSessDir, 'evil.html'), '<script>alert(1)</script>', 'utf8');
    fs.writeFileSync(path.join(brainSessDir, 'icon.svg'), '<svg onload="alert(1)"/>', 'utf8');
    fs.writeFileSync(path.join(brainSessDir, '.hidden.md'), 'secret', 'utf8');
    fs.writeFileSync(path.join(brainSessDir, 'session.db'), 'SQLite format 3\0', 'utf8');
    fs.writeFileSync(
      path.join(brainSessDir, 'nul_corrupt.txt'),
      Buffer.from('ok\x00binary'),
    );
    fs.writeFileSync(path.join(outsideDir, 'escaped.md'), 'MUST NOT BE READ', 'utf8');

    // Create a real Windows directory junction (or Unix dir symlink) inside brain session dir pointing outside
    const junctionPath = path.join(brainSessDir, 'linked_escape');
    fs.symlinkSync(outsideDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');

    // Hardened legacy helpers
    expect(isSafeArtifactSegment('implementation_plan.md')).toBe(true);
    expect(isSafeArtifactSegment('../outside.md')).toBe(false);
    expect(isSafeArtifactSegment('file.md ')).toBe(false);
    expect(isSafeArtifactSegment('file.md:stream')).toBe(false);
    expect(isAllowedArtifactExtension('evil.html')).toBe(false);
    expect(isAllowedArtifactExtension('icon.svg')).toBe(false);

    const listed = listAgySessionArtifacts(appDataPath, nativeSessId);
    expect(listed.map((a) => a.name).sort()).toEqual([
      'implementation_plan.md',
      'nul_corrupt.txt',
      'patch.diff',
    ]);

    expect(readAgySessionArtifact(appDataPath, nativeSessId, 'evil.html')).toBeNull();
    expect(readAgySessionArtifact(appDataPath, nativeSessId, 'icon.svg')).toBeNull();
    expect(readAgySessionArtifact(appDataPath, nativeSessId, 'session.db')).toBeNull();
    expect(readAgySessionArtifact(appDataPath, nativeSessId, '.hidden.md')).toBeNull();
    expect(readAgySessionArtifact(appDataPath, nativeSessId, '../outside-secret/escaped.md')).toBeNull();
    expect(readAgySessionArtifact(appDataPath, nativeSessId, 'linked_escape/escaped.md')).toBeNull();
    expect(readAgySessionArtifact(appDataPath, nativeSessId, 'nul_corrupt.txt')).toBeNull();

    const readLegacy = readAgySessionArtifact(appDataPath, nativeSessId, 'implementation_plan.md');
    expect(readLegacy).not.toBeNull();
    expect(readLegacy?.content).toContain('# Plan');

    // NP-14 AgyNativeArtifactService: opaque IDs, redaction, and independent media gate
    const binding = makeBinding('gen_1');
    const service = new AgyNativeArtifactService({ now: () => 1_760_000_100_000 });
    service.attachConnection(binding, {
      connectionId: 'conn_1',
      rootNativeSessionId: nativeSessId,
      appDataPath,
    });

    const summaries = service.syncBrainArtifacts(binding);
    expect(summaries.length).toBe(2); // implementation_plan.md + patch.diff (nul_corrupt & media excluded)
    expect(summaries.some((s) => s.title === 'evil.html' || s.title === 'browser_preview.png')).toBe(false);
    expect(containsRawHostPath(JSON.stringify(summaries))).toBe(false);

    const planSummary = summaries.find((s) => s.title === 'implementation_plan.md')!;
    const planContent = service.readArtifact(binding, planSummary.artifactId)!;
    expect(planContent).not.toBeNull();
    expect(planContent.content).not.toContain('D:\\SecretUser');
    expect(planContent.content).not.toContain('secret_oauth_code_123');
    expect(planContent.content).not.toContain('ya29.a0AfB_secret_token_9999999999');
    expect(planContent.content).not.toContain('https://evil.example');
    expect(planContent.content).toContain('https://antigravity.google/docs/artifact-review/');
    expect(planContent.security.secretsRedactedCount).toBeGreaterThanOrEqual(2);
    expect(planContent.security.hostPathsRedactedCount).toBeGreaterThanOrEqual(1);
    expect(planContent.security.htmlStrippedOrEscaped).toBe(true);
    expect(planContent.security.unsafeLinksBlockedCount).toBe(2);
    expect(containsRawHostPath(JSON.stringify(planContent))).toBe(false);

    // Reject path-like artifact IDs in readArtifact
    expect(service.readArtifact(binding, 'D:\\SecretUser\\file.md')).toBeNull();
    expect(service.readArtifact(binding, '../implementation_plan.md')).toBeNull();

    // Independent media gate enables safe metadata-only PNG reference, still excludes SVG
    service.configureGates({ mediaArtifactsEnabled: true });
    const withMedia = service.syncBrainArtifacts(binding);
    const pngSummary = withMedia.find((s) => s.title === 'browser_preview.png');
    expect(pngSummary?.contentKind).toBe('media_ref');
    expect(withMedia.some((s) => s.title === 'icon.svg')).toBe(false);
    const pngContent = service.readArtifact(binding, pngSummary!.artifactId)!;
    expect(pngContent.content).toContain('"magicVerified": true');
    expect(pngContent.content).toContain('"mimeType": "image/png"');

    // Turning media gate off immediately hides media references without losing text artifacts
    service.configureGates({ mediaArtifactsEnabled: false });
    expect(service.listArtifacts(binding).some((s) => s.contentKind === 'media_ref')).toBe(false);
    expect(service.readArtifact(binding, pngSummary!.artifactId)).toBeNull();
    expect(service.readArtifact(binding, planSummary.artifactId)).not.toBeNull();
  });
});

describe('NP-14 · Suite 2: Joint Teamwork Prompt Artifact Review Bridge (T12 + G3-03)', () => {
  it('keeps native approvals closed when gate/wire unverified and enforces strict same-binding/conn/artifact/requestId on verified approval & rejection', async () => {
    const binding = makeBinding('gen_tw_1', 'rt_tw_1');
    const artifactId = 'art_tw_prompt_1';
    const requestId = 'req_tw_approve_1';

    // 1. Default unverified transport & reviewControlEnabled=false -> fail closed
    const unverifiedService = new AgyNativeArtifactService();
    unverifiedService.attachConnection(binding, {
      connectionId: 'conn_tw_1',
      rootNativeSessionId: 'native_tw_1',
    });
    unverifiedService.registerObservedArtifact(binding, {
      artifactId,
      title: 'teamwork-prompt.md',
      originKind: 'teamwork_prompt',
      contentKind: 'markdown',
      content: '# Prompt Artifact\nBuild verified feature.',
      evidence: {
        kind: 'live_protocol',
        connectionId: 'conn_tw_1',
        ingressOrdinal: 1,
        wireVariant: 'acp_v1',
        observedAt: 1000,
      },
    });
    unverifiedService.registerPendingReviewRequest({
      binding,
      connectionId: 'conn_tw_1',
      artifactId,
      requestId,
      wireSupport: 'unverified_pending_live_capture',
    });

    const portOff = unverifiedService.createTeamworkArtifactReviewPort();
    expect(portOff.getReviewCapability(binding, artifactId).canApproveViaNativeProtocol).toBe(false);
    expect(portOff.getReviewCapability(binding, artifactId).reasonCode).toBe('review_control_gate_disabled');

    // Even if reviewControlEnabled=true, unverified wire schema MUST stay closed
    unverifiedService.configureGates({ reviewControlEnabled: true });
    expect(portOff.getReviewCapability(binding, artifactId).canApproveViaNativeProtocol).toBe(false);
    expect(portOff.getReviewCapability(binding, artifactId).reasonCode).toBe('review_wire_schema_unverified');
    const deniedSubmit = await portOff.submitNativeArtifactApproval!({
      binding,
      artifactId,
      decision: 'approve',
      requestId,
      idempotencyKey: 'idem_unverified_1',
    });
    expect(deniedSubmit.accepted).toBe(false);
    expect(deniedSubmit.state).toBe('unsupported');

    // 2. Joint test with AgyTeamworkWorkflowObserver using synthetic verified transport
    const verifiedService = new AgyNativeArtifactService({
      gates: { nativeArtifactsEnabled: true, reviewControlEnabled: true },
      reviewTransport: createSyntheticVerifiedReviewTransport(),
    });
    verifiedService.attachConnection(binding, {
      connectionId: 'conn_tw_live',
      rootNativeSessionId: 'native_tw_live',
    });
    verifiedService.registerObservedArtifact(binding, {
      artifactId,
      title: 'teamwork-prompt.md',
      originKind: 'teamwork_prompt',
      contentKind: 'markdown',
      content: '# Teamwork Prompt\nPath D:\\Private\\secret',
      evidence: {
        kind: 'live_protocol',
        connectionId: 'conn_tw_live',
        ingressOrdinal: 2,
        wireVariant: 'acp_v1',
        observedAt: 2000,
      },
    });
    verifiedService.registerPendingReviewRequest({
      binding,
      connectionId: 'conn_tw_live',
      artifactId,
      requestId,
      wireSupport: 'verified_live_wire',
      allowedDecisions: ['approve', 'reject'],
    });

    const reviewPort = verifiedService.createTeamworkArtifactReviewPort();
    const teamwork = new AgyTeamworkWorkflowObserver({
      featureGates: { teamworkEnabled: true, reviewControlEnabled: true },
      artifactReviewPort: reviewPort,
    });
    teamwork.handleReconnect(binding, 'conn_tw_live', 'fresh', 'native_tw_live');
    teamwork.acceptIngressFrame({
      binding,
      connectionId: 'conn_tw_live',
      ingressOrdinal: 1,
      channel: 'live',
      originSession: 'native_tw_live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'native_tw_live',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'teamwork', description: 'Teamwork' }],
          },
        },
      },
    });
    teamwork.acceptIngressFrame({
      binding,
      connectionId: 'conn_tw_live',
      ingressOrdinal: 2,
      channel: 'live',
      originSession: 'native_tw_live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'native_tw_live',
          update: {
            sessionUpdate: 'teamwork_update',
            event: 'prompt_artifact',
            artifactId,
            title: 'teamwork-prompt.md',
            requiresApproval: true,
            approvalRequestId: requestId,
          },
        },
      },
    });

    // Reject wrong requestId
    const wrongReq = await reviewPort.submitNativeArtifactApproval!({
      binding,
      artifactId,
      decision: 'reject',
      requestId: 'req_wrong_999',
      idempotencyKey: 'idem_wrong_req',
    });
    expect(wrongReq.accepted).toBe(false);
    expect(wrongReq.state).toBe('conflict');

    // Submit formal rejection via Teamwork observer -> NP-14 port
    const rejectResult = await teamwork.submitNativePromptArtifactDecision({
      binding,
      decision: 'reject',
      idempotencyKey: 'idem_reject_1',
    });
    expect(rejectResult.accepted).toBe(true);
    expect(rejectResult.state).toBe('response_written');

    // Replay same idempotencyKey -> returns identical receipt without double submit
    const replayReject = await reviewPort.submitNativeArtifactApproval!({
      binding,
      artifactId,
      decision: 'reject',
      requestId,
      idempotencyKey: 'idem_reject_1',
    });
    expect(replayReject).toEqual(rejectResult);

    // Same idempotencyKey with different decision -> conflict
    const conflictIdem = await reviewPort.submitNativeArtifactApproval!({
      binding,
      artifactId,
      decision: 'approve',
      requestId,
      idempotencyKey: 'idem_reject_1',
    });
    expect(conflictIdem.accepted).toBe(false);
    expect(conflictIdem.state).toBe('conflict');
    expect(conflictIdem.reasonCode).toBe('idempotency_key_conflict');

    // Verify Teamwork blocked project creation after rejection
    const proj = teamwork.getPublicProjection(binding)!;
    expect(proj.approvalGate).toBe('rejected');
    expect(proj.projectScope.nativeProject.created).toBe(false);
    expect(proj.milestones ?? []).toHaveLength(0);
  });

  it('rejects approval completion when connection closes or artifact revision advances mid-flight (G3-03 async race guard)', async () => {
    const binding = makeBinding('gen_race', 'rt_race');
    const artifactId = 'art_race_1';
    const requestId = 'req_race_1';

    let serviceRef!: AgyNativeArtifactService;
    serviceRef = new AgyNativeArtifactService({
      gates: { nativeArtifactsEnabled: true, reviewControlEnabled: true },
      reviewTransport: {
        getWireSupportStatus: () => 'verified_live_wire',
        async submitReviewAction() {
          // Simulate artifact revision update / disconnect while request is in flight
          serviceRef.handleTransportClosed(binding, 'conn_race_1');
          return {
            accepted: true,
            state: 'response_written',
            receiptId: 'rcpt_late',
            reasonCode: 'synthetic_late',
          };
        },
      },
    });
    serviceRef.attachConnection(binding, {
      connectionId: 'conn_race_1',
      rootNativeSessionId: 'native_race_1',
    });
    serviceRef.registerObservedArtifact(binding, {
      artifactId,
      title: 'prompt.md',
      originKind: 'teamwork_prompt',
      contentKind: 'markdown',
      content: '# Prompt',
      evidence: {
        kind: 'live_protocol',
        connectionId: 'conn_race_1',
        ingressOrdinal: 1,
        wireVariant: 'acp_v1',
        observedAt: 3000,
      },
    });
    serviceRef.registerPendingReviewRequest({
      binding,
      connectionId: 'conn_race_1',
      artifactId,
      requestId,
      wireSupport: 'verified_live_wire',
    });

    const port = serviceRef.createTeamworkArtifactReviewPort();
    const res = await port.submitNativeArtifactApproval!({
      binding,
      artifactId,
      decision: 'approve',
      requestId,
      idempotencyKey: 'idem_race_1',
    });
    expect(res.accepted).toBe(false);
    expect(res.state).toBe('conflict');
    expect(res.reasonCode).toBe('binding_or_artifact_changed_during_submit');
  });
});

describe('NP-14 · Suite 3: Joint Dynamic Workflow Artifact Reader Bridge (T13)', () => {
  it('enforces opaque IDs, rejects raw ScriptPath & cross-scope access, paginates & redacts scripts/results inside DynamicWorkflowObserver', () => {
    const binding = makeBinding('gen_dyn_1', 'rt_dyn_1');
    const otherBinding = makeBinding('gen_dyn_2', 'rt_dyn_1');
    const workflowId = asWorkflowId('wf_dyn_np14_1');
    const otherWorkflowId = asWorkflowId('wf_dyn_np14_other');

    const service = new AgyNativeArtifactService({
      gates: { nativeArtifactsEnabled: true },
    });
    service.attachConnection(binding, {
      connectionId: 'conn_dyn_1',
      rootNativeSessionId: 'native_dyn_1',
    });

    const liveEv = {
      kind: 'live_protocol' as const,
      connectionId: 'conn_dyn_1',
      ingressOrdinal: 1,
      wireVariant: 'acp_v1',
      observedAt: 5000,
    };

    expect(
      service.registerApprovedWorkflowScript({
        binding,
        workflowId,
        artifactId: 'script_dyn_1',
        text: `${'print("step")\n'.repeat(12)}# secret token Bearer ya29.secret_dyn_token_123456\n`,
        evidence: liveEv,
      }),
    ).toBe(true);

    expect(
      service.registerApprovedWorkflowResult({
        binding,
        workflowId,
        artifactId: 'result_dyn_1',
        payload: [
          { row: 1, path: 'C:\\Users\\alice\\secret.ts' },
          { row: 2, status: 'ok' },
          { row: 3, status: 'ok' },
        ],
        evidence: liveEv,
      }),
    ).toBe(true);

    const readerPort = service.createDynamicWorkflowArtifactReaderPort();
    const observer = new DynamicWorkflowObserver({ artifactReader: readerPort });
    observer.registerRootSession(binding, 'native_dyn_1', 'conn_dyn_1');

    // Reject path-like ScriptPath and cross-workflow/cross-generation reads
    expect(readerPort.isApprovedArtifactId(binding, workflowId, 'C:\\temp\\workflow.py')).toBe(false);
    expect(readerPort.isApprovedArtifactId(binding, otherWorkflowId, 'script_dyn_1')).toBe(false);
    expect(readerPort.isApprovedArtifactId(otherBinding, workflowId, 'script_dyn_1')).toBe(false);
    expect(readerPort.isApprovedArtifactId(binding, workflowId, 'script_dyn_1')).toBe(true);

    const badScript = readerPort.readScriptPreview({
      binding,
      workflowId,
      artifactId: '../secret.py',
    });
    expect(badScript.ok).toBe(false);
    if (!badScript.ok) expect(badScript.errorCode).toBe('UNAPPROVED_ARTIFACT_SCOPE');

    // Paginate script preview + verify secret redaction
    const p1 = readerPort.readScriptPreview({
      binding,
      workflowId,
      artifactId: 'script_dyn_1',
      maxChars: 80,
    });
    expect(p1.ok).toBe(true);
    if (p1.ok) {
      expect(p1.hasMore).toBe(true);
      expect(p1.nextPageToken).toBeTruthy();
      const p2 = readerPort.readScriptPreview({
        binding,
        workflowId,
        artifactId: 'script_dyn_1',
        pageToken: p1.nextPageToken!,
        maxChars: 400,
      });
      expect(p2.ok).toBe(true);
      if (p2.ok) {
        const full = p1.content + p2.content;
        expect(full).not.toContain('ya29.secret_dyn_token_123456');
        expect(full).toContain('[redacted-token]');
      }
    }

    // Paginate structured JSON result + verify host path redaction
    const r1 = readerPort.readStructuredResult({
      binding,
      workflowId,
      artifactId: 'result_dyn_1',
      limit: 2,
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.format).toBe('json_array');
      expect(r1.items).toHaveLength(2);
      expect(r1.hasMore).toBe(true);
      expect(JSON.stringify(r1.items)).not.toContain('C:\\Users\\alice');
    }

    // Confirm DynamicWorkflowObserver exposes read-only script/result through the same port
    expect(observer.getArtifactReader().contractRevision).toBe(readerPort.contractRevision);
  });
});

describe('NP-14 · Suite 4: Plan, Diff Separation & Browser Agent Observation (T16 Replay + History Isolation)', () => {
  it('separates standard ACP plan/steps and tool diffs from Artifact Review, classifies Browser surfaces, and isolates history_replay', () => {
    const root = makeTempDir('hm-np14-browser-');
    const appDataPath = path.join(root, 'app-data');
    const nativeSessId = 'native_sess_np14_fixture';
    const brainDir = path.join(appDataPath, 'brain', nativeSessId);
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(
      path.join(brainDir, 'browser_preview.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]),
    );

    const binding = makeBinding('gen_t16', 'rt_t16');
    const observer = new AgyPlanDiffBrowserObserver({
      mediaArtifactsEnabled: false,
      now: () => 1_760_000_500_000,
    });
    observer.attachConnection(binding, {
      connectionId: 'conn_t16_live',
      rootNativeSessionId: nativeSessId,
      appDataPath,
    });

    const frames = loadNp14NdjsonFixture(resolveNp14FixturePath('t16-plan-diff-browser.ndjson'));
    const envelopes = toNativeIngressEnvelopes(binding, frames, nativeSessId);

    for (const env of envelopes) {
      const res = observer.acceptFrame(env);
      if (env.channel === 'history_replay') {
        expect(res.accepted).toBe(false);
        expect(res.reasonCode).toBe('history_replay_isolated');
      } else {
        expect(res.accepted).toBe(true);
      }
    }

    // Plan snapshot: mode exited back to default in frame 5, history_replay frame 8 MUST NOT re-activate planModeActive!
    const plan = observer.getPlanSnapshot(binding);
    expect(plan.planModeActive).toBe(false);
    expect(plan.enforcement).toBe('native');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.source).toBe('agy_update_steps');

    // Tool diff separated & path-sanitized
    const diffs = observer.listToolDiffs(binding);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.origin).toBe('acp_tool_diff');
    expect(diffs[0]?.relativeDisplayPath).toBe('Secret/project/README.md'.replace('Secret', 'secret'));
    expect(containsRawHostPath(JSON.stringify(diffs))).toBe(false);

    // Browser observation: App embedded + CLI Chrome MCP logs/roles, controlSupported always false, media gated off
    const browserOff = observer.getBrowserObservation(binding);
    expect(browserOff.controlSupported).toBe(false);
    expect(browserOff.surface).toBe('cli_chrome_mcp');
    expect(browserOff.roles.map((r) => r.surface).sort()).toEqual([
      'app_embedded_browser',
      'cli_chrome_mcp',
    ]);
    expect(browserOff.logs.every((l) => !JSON.stringify(l).includes('ya29.supersecret'))).toBe(true);
    expect(browserOff.mediaGateEnabled).toBe(false);
    expect(browserOff.mediaReferences).toHaveLength(0);

    // Enable media gate -> PNG metadata visible with magicVerified=true
    observer.setMediaArtifactsEnabled(true);
    const browserOn = observer.getBrowserObservation(binding);
    expect(browserOn.mediaGateEnabled).toBe(true);
    expect(browserOn.mediaReferences).toHaveLength(1);
    expect(browserOn.mediaReferences[0]?.mimeType).toBe('image/png');
    expect(browserOn.mediaReferences[0]?.magicVerified).toBe(true);

    // Passive historical binding can read history_replay frames cleanly as historical=true
    const histBinding = makeBinding('gen_hist', 'rt_hist');
    const histFrame = envelopes.find((e) => e.channel === 'history_replay')!;
    const histRes = observer.ingestHistoricalReplay({ ...histFrame, binding: histBinding });
    expect(histRes.accepted).toBe(true);
    expect(observer.getPlanSnapshot(histBinding).isHistorical).toBe(true);
    expect(observer.getPlanSnapshot(histBinding).planModeActive).toBe(true);

    // Verify capability contributions match AGY-W13..W16
    expect(NP14_CAPABILITY_CONTRIBUTIONS.map((c) => c.capabilityId)).toEqual([
      'AGY-W13',
      'AGY-W14',
      'AGY-W15',
      'AGY-W16',
    ]);
    expect(redactSensitiveContent('?token=abc&code=secret_123').secretsRedactedCount).toBe(2);
  });
});
