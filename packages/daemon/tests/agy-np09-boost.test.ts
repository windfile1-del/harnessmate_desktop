import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGY_NATIVE_CONTRACT_REVISION,
  WorkflowDetailDtoSchema,
  WorkflowDetailSchema,
  asActivityId,
  asBindingGeneration,
  asNativeAgentId,
  asWorkId,
  type AgentIdentity,
} from '@harnessmate/protocol';
import { HarnessMateStore } from '../src/db/sqlite.js';
import {
  AgyNativeCommandCatalogService,
  AgyNativeCommandRouter,
  NativeCommandRouterError,
  type LiveWorkflowDispatchInput,
} from '../src/harnesses/agy/native/commands/index.js';
import { mintAgyDispatchProvenance } from '../src/harnesses/agy/native/wiring/provenance.js';
import { AgyNativeRuntimeRegistry } from '../src/harnesses/agy/native/wiring/registry.js';
import {
  BOOST_CAPABILITY_ID,
  BOOST_PLAN_TIER_EVIDENCE_MATRIX,
  BoostWorkflowObserver,
  classifyBoostSignalLabel,
  createBoostCapabilityContribution,
  createT11BoostSyntheticFixtures,
  makeBoostSignals,
  makeBoostSyntheticBinding,
  makeConfirmedBoostVerifierAgent,
  resolveBoostEligibility,
  sanitizeBoostEligibilityForPublic,
  validateBoostLaunchIntent,
} from '../src/harnesses/agy/native/workflows/boost/index.js';

const tempDirs: string[] = [];
const openStores: HarnessMateStore[] = [];

function createTempStore(sessionId: string, instanceId: string): HarnessMateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-np09-boost-'));
  tempDirs.push(dir);
  const store = new HarnessMateStore(path.join(dir, 'test.sqlite'));
  openStores.push(store);
  const ws = store.createWorkspace({
    id: 'ws_np09_1',
    name: 'NP-09 Boost Workspace',
    rootPath: dir,
    isGitRepo: false,
    gitBranch: null,
    createdAt: 1_700_000_000_000,
  });
  store.createSession({
    id: sessionId,
    workspaceId: ws.id,
    harnessId: instanceId,
    harnessKind: 'agy',
    nativeSessionId: null,
    cwd: ws.rootPath,
    worktreeBranch: null,
    title: 'NP-09 Boost Test Session',
    status: 'idle',
    model: null,
    reasoningEffort: null,
    permissionMode: 'manual',
    lastSeq: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  return store;
}

afterEach(() => {
  while (openStores.length > 0) {
    try {
      openStores.pop()?.close();
    } catch {
      // ignore close errors during cleanup
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('NP-09 Boost eligibility, model/tier advertisement, and launch intent validation', () => {
  it('resolves deterministic eligibility across plan tiers, advertisements, and preserves original mode intent without auto-upgrading', () => {
    // 1. Eligible Pro + advertised /boost + explicit opt-in
    const proOk = resolveBoostEligibility(makeBoostSignals({ tierName: 'Pro', effectiveModel: 'gemini-3.8-pro' }), {
      explicitPaidOptIn: true,
      originalModeIntent: 'boost',
      nowMs: 1_700_000_000_000,
    });
    expect(proOk.status).toBe('eligible_advertised');
    expect(proOk.eligible).toBe(true);
    expect(proOk.canLaunchNow).toBe(true);
    expect(proOk.launchGate).toBe('available');
    expect(proOk.autoUpgradeBlocked).toBe(true);
    expect(proOk.tierObserved.kind).toBe('known');
    expect(proOk.modelObserved.kind).toBe('known');

    // 2. Eligible Pro, but user has NOT explicitly opted into paid mode -> no auto-upgrade
    const optInRequired = resolveBoostEligibility(makeBoostSignals({ tierName: 'Pro' }), {
      explicitPaidOptIn: false,
      originalModeIntent: 'plan',
    });
    expect(optInRequired.status).toBe('paid_opt_in_required');
    expect(optInRequired.eligible).toBe(true);
    expect(optInRequired.canLaunchNow).toBe(false);
    expect(optInRequired.guidance.originalModeIntent).toBe('plan');
    expect(optInRequired.guidance.autoUpgradeBlocked).toBe(true);

    // 3. Free tier -> deterministic ineligibility prompt, original mode intent preserved
    const freeDenied = resolveBoostEligibility(makeBoostSignals({ tierName: 'Free' }), {
      originalModeIntent: 'normal',
    });
    expect(freeDenied.status).toBe('ineligible_tier');
    expect(freeDenied.eligible).toBe(false);
    expect(freeDenied.canLaunchNow).toBe(false);
    expect(freeDenied.launchGate).toBe('unsupported');
    expect(freeDenied.guidance.reasonCode).toBe('tier_ineligible');
    expect(freeDenied.guidance.originalModeIntent).toBe('normal');
    expect(freeDenied.guidance.draftPreserved).toBe(true);
    expect(freeDenied.guidance.autoUpgradeBlocked).toBe(true);

    // 4. Unverified profile -> not_tested
    const unauth = resolveBoostEligibility(makeBoostSignals({ profileVerified: false }), {
      originalModeIntent: 'normal',
    });
    expect(unauth.status).toBe('unverified_profile');
    expect(unauth.launchGate).toBe('not_tested');

    // 5. Desktop source -> unsupported
    const desktop = resolveBoostEligibility(makeBoostSignals({ source: 'agy_desktop' }));
    expect(desktop.status).toBe('desktop_source_unsupported');
    expect(desktop.launchGate).toBe('unsupported');

    // 6. Revoked / not advertised -> unsupported
    const revoked = resolveBoostEligibility(makeBoostSignals({ advertisedCommands: [] }));
    expect(revoked.status).toBe('not_advertised');
    expect(revoked.boostAdvertised).toBe(false);
    expect(revoked.launchGate).toBe('unsupported');

    // 7. Broadcast never received -> unknown
    const unknownAdv = resolveBoostEligibility(makeBoostSignals({ advertisedCommands: null }));
    expect(unknownAdv.status).toBe('advertisement_unknown');
    expect(unknownAdv.boostAdvertised).toBeNull();
    expect(unknownAdv.launchGate).toBe('unknown');

    // 8. Public DTO allowlist strips internal fields
    const dto = sanitizeBoostEligibilityForPublic(proOk, 1_700_000_001_000);
    expect(JSON.stringify(dto)).not.toContain('connectionId');
    expect(dto.autoUpgradeBlocked).toBe(true);
    expect(BOOST_PLAN_TIER_EVIDENCE_MATRIX.length).toBeGreaterThanOrEqual(4);
  });

  it('enforces explicit user live_workflow launch, blocks model-spontaneous / auto-upgrade / separate CLI fallback, and wires cleanly into NP-06 catalog & router', async () => {
    const binding = makeBoostSyntheticBinding();
    const eligible = resolveBoostEligibility(makeBoostSignals(), { explicitPaidOptIn: true });

    // Reject model-spontaneous launch
    const modelAttempt = validateBoostLaunchIntent({
      binding,
      lane: 'live_workflow',
      userInitiated: false,
      explicitUserSelection: true,
      task: 'Run boost silently',
      eligibility: eligible,
    });
    expect(modelAttempt.ok).toBe(false);
    if (!modelAttempt.ok) {
      expect(modelAttempt.reasonCode).toBe('model_spontaneous_boost_forbidden');
    }

    // Reject auto-upgrade attempt
    const autoUpgrade = validateBoostLaunchIntent({
      binding,
      lane: 'live_workflow',
      userInitiated: true,
      explicitUserSelection: true,
      autoUpgradeAttempt: true,
      task: 'Upgrade to paid mode',
      eligibility: eligible,
    });
    expect(autoUpgrade.ok).toBe(false);
    if (!autoUpgrade.ok) {
      expect(autoUpgrade.reasonCode).toBe('auto_paid_upgrade_forbidden');
    }

    // Reject separate auxiliary CLI instance
    const auxCli = validateBoostLaunchIntent({
      binding,
      lane: 'live_workflow',
      userInitiated: true,
      explicitUserSelection: true,
      useAuxiliaryCli: true,
      task: 'Spawn second CLI',
      eligibility: eligible,
    });
    expect(auxCli.ok).toBe(false);
    if (!auxCli.ok) {
      expect(auxCli.reasonCode).toBe('separate_cli_instance_forbidden');
    }

    // Reject non-live_workflow lane
    const wrongLane = validateBoostLaunchIntent({
      binding,
      lane: 'query',
      userInitiated: true,
      explicitUserSelection: true,
      task: 'Wrong lane',
      eligibility: eligible,
    });
    expect(wrongLane.ok).toBe(false);

    // Valid explicit user live_workflow launch preserves slash prefix and ordered attachments
    const valid = validateBoostLaunchIntent({
      binding,
      lane: 'live_workflow',
      userInitiated: true,
      explicitUserSelection: true,
      task: '/boost Audit lock ordering',
      attachmentIds: ['att_1', 'att_2'],
      eligibility: eligible,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.promptText).toBe('/boost Audit lock ordering');
      expect(valid.attachmentIds).toEqual(['att_1', 'att_2']);
    }

    // Integrate descriptor contribution into NP-06 catalog & router
    const catalog = new AgyNativeCommandCatalogService();
    const dispose = catalog.registerWorkflowDescriptor(createBoostCapabilityContribution());
    const { snapshot } = catalog.updateBindingSignals(binding, makeBoostSignals());

    const dispatches: LiveWorkflowDispatchInput[] = [];
    const router = new AgyNativeCommandRouter({
      catalog,
      dispatchLiveWorkflow: async (input) => {
        dispatches.push(input);
        return {
          activityId: asActivityId('act_boost_routed_1'),
          turnId: 'turn_boost_routed_1',
          modeEvidenceObserved: true,
        };
      },
    });

    const resp = await router.executeCommand({
      binding,
      receiptId: 'rcpt_boost_1',
      provenance: mintAgyDispatchProvenance('human_direct', 'desktop', 'boost-test'),
      request: {
        bindingGeneration: binding.generation,
        catalogRevision: snapshot.capabilitiesRevision,
        capabilityId: BOOST_CAPABILITY_ID,
        actionKey: 'launch_boost',
        args: { task: 'Verify Boost live_workflow routing', attachmentIds: ['att_a', 'att_b'] },
        idempotencyKey: 'idem_boost_1',
      },
    });

    expect(resp.kind).toBe('accepted');
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.promptText).toBe('/boost Verify Boost live_workflow routing');
    expect(dispatches[0]?.attachmentIds).toEqual(['att_a', 'att_b']);

    // Non-human provenance MUST be blocked for consumer OAuth
    await expect(
      router.executeCommand({
        binding,
        receiptId: 'rcpt_boost_2',
        provenance: mintAgyDispatchProvenance('hm_orchestrator', 'daemon', 'auto-dispatch'),
        request: {
          bindingGeneration: binding.generation,
          catalogRevision: snapshot.capabilitiesRevision,
          capabilityId: BOOST_CAPABILITY_ID,
          actionKey: 'launch_boost',
          args: { task: 'Automated boost forbidden' },
          idempotencyKey: 'idem_boost_2',
        },
      }),
    ).rejects.toThrowError(NativeCommandRouterError);

    dispose();
  });
});

describe('NP-09 BoostWorkflowObserver T11 lifecycle, phases, unknown labels, duplicates, server denial, and stop', () => {
  it('T11-A: omits phases until observed, records canonical initial/improvement/verification phases, separates lineage, persists to SQLite, and serves allowlisted workflow resources', () => {
    const pack = createT11BoostSyntheticFixtures();
    const store = createTempStore(pack.binding.sessionId, pack.binding.instanceId);
    const registry = new AgyNativeRuntimeRegistry(store, {
      enabled: true,
      nativeLifecycle: true,
      nativeCommands: true,
    });
    const storedBinding = registry.ensureRuntimeBinding({
      sessionId: pack.binding.sessionId,
      instanceId: pack.binding.instanceId,
      profileRef: 'profile_pro_test',
      sourceRef: 'acp',
      status: 'attached',
    });
    const binding = {
      runtimeId: storedBinding.runtimeId,
      sessionId: storedBinding.sessionId,
      instanceId: storedBinding.instanceId,
      generation: storedBinding.generation,
    };

    const observer = new BoostWorkflowObserver();
    observer.registerBinding({
      binding,
      connectionId: pack.connectionId,
      rootNativeSessionId: pack.rootNativeSessionId,
    });

    const confirmedVerifier = makeConfirmedBoostVerifierAgent();
    const unconfirmedAgent: AgentIdentity = {
      ...confirmedVerifier,
      id: asNativeAgentId('agt_unconfirmed_99'),
      lineage: 'unresolved',
    };
    observer.syncConfirmedAgent(binding, confirmedVerifier);
    observer.syncConfirmedAgent(binding, unconfirmedAgent);

    const launchRes = observer.recordConfirmedLaunch({
      binding,
      connectionId: pack.connectionId,
      originActivityId: pack.originActivityId,
      workflowId: pack.workflowId,
      objective: 'Audit Boost multi-stage verification',
      observedAt: 1_700_000_001_000,
    });
    expect(launchRes.accepted).toBe(true);
    expect(launchRes.commits).toHaveLength(1);
    observer.commitToRegistry(registry, binding, launchRes.commits);

    // Before any phase signal arrives, `phases` MUST be omitted (undefined), NOT []
    const beforePhases = observer.getWorkflowState(binding, pack.workflowId)!;
    expect(beforePhases.workflow.detail.kind).toBe('boost');
    if (beforePhases.workflow.detail.kind === 'boost') {
      expect(beforePhases.workflow.detail.phases).toBeUndefined();
    }
    const emptyPhaseRes = observer.readWorkflowResource({
      binding,
      workflowId: pack.workflowId,
      resource: 'phases',
      limit: 20,
    });
    expect(emptyPhaseRes.available).toBe(false);
    expect(emptyPhaseRes.sourceUnavailableReason).toBe('boost_phases_not_observed');

    // Feed canonical initial -> improvement -> verification frames
    const eventsReceived: string[] = [];
    const unsubscribe = registry.subscribeSession(binding.sessionId, (evt) => {
      eventsReceived.push(evt.type);
    });

    for (let i = 0; i < pack.frames.canonicalPhases.length; i += 1) {
      const f = pack.frames.canonicalPhases[i]!;
      const res = observer.acceptFrame(
        { ...f, binding },
        {
          relatedWorkId: i === 2 ? pack.workIds.verifyWorkId : undefined,
          // Try passing unconfirmed agent on step 1 and confirmed verifier on step 2
          confirmedAgentId: i === 1 ? unconfirmedAgent.id : i === 2 ? confirmedVerifier.id : undefined,
          observedAt: 1_700_000_010_000 + i * 1_000,
        },
      );
      expect(res.accepted).toBe(true);
      expect(res.deduplicated).toBe(false);
      observer.commitToRegistry(registry, binding, res.commits);
    }
    unsubscribe();

    expect(eventsReceived).toEqual([
      'native.workflow.changed',
      'native.workflow.changed',
      'native.workflow.changed',
    ]);

    const studio = observer.getStudioSnapshot(binding, pack.workflowId, 1_700_000_020_000)!;
    expect(studio.hasObservedPhases).toBe(true);
    expect(studio.stages).toHaveLength(3);
    expect(studio.phaseClassifications.phase_initial).toMatchObject({
      kind: 'canonical',
      phaseKind: 'initial',
    });
    expect(studio.phaseClassifications.phase_improvement).toMatchObject({
      kind: 'canonical',
      phaseKind: 'improvement',
    });
    expect(studio.phaseClassifications.phase_verification).toMatchObject({
      kind: 'canonical',
      phaseKind: 'verification',
    });

    // Unconfirmed agent MUST NOT be linked to phase_improvement; confirmed verifier IS linked to phase_verification
    expect(studio.stages?.[1]?.agentIds).toBeUndefined();
    expect(studio.stages?.[2]?.agentIds).toEqual([confirmedVerifier.id]);

    // Check persisted projection in SQLite matches protocol Zod schema & public allowlist
    const projection = registry.getProjectionForSession(binding.sessionId, binding.instanceId);
    expect(projection.contractRevision).toBe(AGY_NATIVE_CONTRACT_REVISION);
    expect(projection.workflows).toHaveLength(1);
    const persistedWf = projection.workflows[0]!;
    expect(WorkflowDetailDtoSchema.safeParse(persistedWf.detail).success).toBe(true);
    expect(JSON.stringify(projection)).not.toContain(pack.connectionId);

    // Check paginated workflow resources
    const phasesPage = observer.readWorkflowResource({
      binding,
      workflowId: pack.workflowId,
      resource: 'phases',
      limit: 2,
    });
    expect(phasesPage.available).toBe(true);
    expect(phasesPage.items).toHaveLength(2);
    expect(phasesPage.hasMore).toBe(true);
    const phasesPage2 = observer.readWorkflowResource({
      binding,
      workflowId: pack.workflowId,
      resource: 'phases',
      pageToken: phasesPage.nextPageToken ?? undefined,
      limit: 2,
    });
    expect(phasesPage2.items).toHaveLength(1);
    expect(phasesPage2.hasMore).toBe(false);

    const logsPage = observer.readWorkflowResource({
      binding,
      workflowId: pack.workflowId,
      resource: 'logs',
      limit: 50,
    });
    expect(logsPage.available).toBe(true);
    expect(logsPage.items.length).toBeGreaterThanOrEqual(4);

    const artifactsPage = observer.readWorkflowResource({
      binding,
      workflowId: pack.workflowId,
      resource: 'artifacts',
      limit: 10,
    });
    expect(artifactsPage.available).toBe(true);
    expect(artifactsPage.items).toHaveLength(1);

    const boardPage = observer.readWorkflowResource({
      binding,
      workflowId: pack.workflowId,
      resource: 'board',
      limit: 10,
    });
    expect(boardPage.available).toBe(false);
    expect(boardPage.sourceUnavailableReason).toBe('boost_board_not_applicable');

    // Feature-off rollback purity: disabling gate hides projection while DB stays intact
    registry.setFeatureFlags({ enabled: false });
    const gatedOff = registry.getProjectionForSession(binding.sessionId, binding.instanceId);
    expect(gatedOff.enabled).toBe(false);
    expect(gatedOff.workflows).toEqual([]);
  });

  it('T11-B & T11-C: preserves unknown stage & role labels without enum coercion or progress inference, omits phases when none sent, and deduplicates repeat frames', () => {
    const pack = createT11BoostSyntheticFixtures();
    const observer = new BoostWorkflowObserver();
    observer.registerBinding({
      binding: pack.binding,
      connectionId: pack.connectionId,
      rootNativeSessionId: pack.rootNativeSessionId,
    });

    // Unknown classifier check
    expect(classifyBoostSignalLabel('Adversarial Critic Audit')).toEqual({
      kind: 'observed_unknown',
      observedLabel: 'Adversarial Critic Audit',
    });
    expect(classifyBoostSignalLabel('verification')).toEqual({
      kind: 'canonical',
      phaseKind: 'verification',
      observedLabel: 'verification',
    });

    observer.recordConfirmedLaunch({
      binding: pack.binding,
      connectionId: pack.connectionId,
      originActivityId: pack.originActivityId,
      workflowId: pack.workflowId,
      objective: 'Test unknown stage, unknown role, and duplicates',
      observedAt: 1_700_000_000_000,
    });

    // 1. Unknown stage
    const first = observer.acceptFrame(pack.frames.unknownStageAndDuplicate[0]!, {
      observedAt: 1_700_000_001_000,
    });
    expect(first.accepted).toBe(true);
    expect(first.deduplicated).toBe(false);
    expect(first.diagnostic?.code).toBe('unknown_stage_preserved');
    const revAfterFirst = observer.getWorkflowState(pack.binding, pack.workflowId)!.revision;

    // 2. Duplicate updateId frame MUST be ignored without bumping revision
    const dup = observer.acceptFrame(pack.frames.unknownStageAndDuplicate[1]!, {
      observedAt: 1_700_000_002_000,
    });
    expect(dup.accepted).toBe(true);
    expect(dup.deduplicated).toBe(true);
    expect(dup.commits).toHaveLength(0);
    expect(dup.diagnostic?.code).toBe('duplicate_frame_ignored');
    expect(observer.getWorkflowState(pack.binding, pack.workflowId)!.revision).toBe(revAfterFirst);

    // 3. Unknown subagent role preserved as observed label
    const roleRes = observer.acceptFrame(pack.frames.unknownStageAndDuplicate[2]!, {
      relatedWorkId: asWorkId('wrk_boost_role_1'),
      observedAt: 1_700_000_003_000,
    });
    expect(roleRes.accepted).toBe(true);
    expect(roleRes.diagnostic?.code).toBe('unknown_role_preserved');

    const studio = observer.getStudioSnapshot(pack.binding, pack.workflowId)!;
    expect(studio.phaseClassifications.stage_adversarial_audit).toEqual({
      kind: 'observed_unknown',
      observedLabel: 'Adversarial Critic Audit',
    });
    expect(studio.roles).toHaveLength(1);
    expect(studio.roles[0]?.observedLabel).toBe('Domain Spec Auditor');
    expect(studio.roles[0]?.classification.kind).toBe('observed_unknown');
    expect(studio.roles[0]?.lineage).toBe('unlinked');
    // Confirm internal WorkflowDetailSchema passes
    expect(WorkflowDetailSchema.safeParse(observer.getWorkflowState(pack.binding)!.workflow.detail).success).toBe(true);
  });

  it('T11-D: handles server denied deterministically, records denial clue, and preserves original mode intent', () => {
    const pack = createT11BoostSyntheticFixtures();
    const observer = new BoostWorkflowObserver();
    observer.registerBinding({
      binding: pack.binding,
      connectionId: pack.connectionId,
      rootNativeSessionId: pack.rootNativeSessionId,
    });
    observer.recordConfirmedLaunch({
      binding: pack.binding,
      connectionId: pack.connectionId,
      originActivityId: pack.originActivityId,
      workflowId: pack.workflowId,
      objective: 'Test server denial',
      launchRpcId: 9001,
    });

    const denialFrame = pack.frames.serverDenied;
    for (const id of [9002, '9001']) {
      const wire = { ...(denialFrame.wire as object), id };
      expect(observer.acceptFrame({ ...denialFrame, wire }).accepted).toBe(false);
    }
    expect(observer.getServerDenial(pack.binding)).toBeNull();
    expect(observer.getWorkflowState(pack.binding, pack.workflowId)?.workflow.state)
      .toMatchObject({ kind: 'known', value: 'running' });

    const denied = observer.acceptFrame(denialFrame, {
      observedAt: 1_700_000_030_000,
    });
    expect(denied.accepted).toBe(true);
    expect(denied.deduplicated).toBe(false);
    expect(denied.diagnostic?.code).toBe('server_denial_recorded');

    // Duplicate denial ignored
    const dupDenied = observer.acceptFrame(pack.frames.serverDenied, {
      observedAt: 1_700_000_031_000,
    });
    expect(dupDenied.deduplicated).toBe(true);

    const state = observer.getWorkflowState(pack.binding, pack.workflowId)!;
    expect(state.workflow.state.kind).toBe('known');
    if (state.workflow.state.kind === 'known') {
      expect(state.workflow.state.value).toBe('failed');
    }
    expect(state.workflow.detail.kind === 'boost' && state.workflow.detail.phases).toBeUndefined();

    // Feed recorded server denial back into eligibility resolver
    const eligibility = resolveBoostEligibility(makeBoostSignals(), {
      serverDenial: observer.getServerDenial(pack.binding),
      originalModeIntent: 'plan',
    });
    expect(eligibility.status).toBe('ineligible_server_denied');
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.launchGate).toBe('unsupported');
    expect(eligibility.guidance.originalModeIntent).toBe('plan');
    expect(eligibility.guidance.autoUpgradeBlocked).toBe(true);
  });

  it('T11-E & isolation: distinguishes stop requested vs confirmed vs disconnect unknown, fences stale generations/history_replay, and blocks model-spontaneous Boost', () => {
    const pack = createT11BoostSyntheticFixtures();
    const observer = new BoostWorkflowObserver();
    observer.registerBinding({
      binding: pack.binding,
      connectionId: pack.connectionId,
      rootNativeSessionId: pack.rootNativeSessionId,
    });

    // 1. Model-spontaneous mention before any user /boost launch MUST be ignored
    const spont = observer.acceptFrame(pack.frames.modelSpontaneousMention);
    expect(spont.accepted).toBe(false);
    expect(spont.diagnostic?.code).toBe('model_spontaneous_ignored');
    expect(observer.getWorkflowState(pack.binding)).toBeNull();

    // 2. Confirmed launch -> Stop requested -> Native cancel confirmed
    observer.recordConfirmedLaunch({
      binding: pack.binding,
      connectionId: pack.connectionId,
      originActivityId: pack.originActivityId,
      workflowId: pack.workflowId,
      observedAt: 1_700_000_000_000,
    });

    const stopReq = observer.handleStopRequested(pack.binding, { observedAt: 1_700_000_005_000 });
    expect(stopReq.accepted).toBe(true);
    let snap = observer.getStudioSnapshot(pack.binding, pack.workflowId)!;
    expect(snap.stop.state).toBe('requested');
    expect(snap.stop.supportedInterruptPath).toBe('root_session_cancel');
    // Workflow is NOT prematurely marked cancelled before native confirmation!
    expect(snap.workflow?.state.kind === 'known' && snap.workflow.state.value).toBe('running');

    const stopConf = observer.acceptFrame(pack.frames.nativeCancelConfirmed, {
      observedAt: 1_700_000_006_000,
    });
    expect(stopConf.accepted).toBe(true);
    expect(stopConf.diagnostic?.code).toBe('stop_confirmed');
    snap = observer.getStudioSnapshot(pack.binding, pack.workflowId)!;
    expect(snap.stop.state).toBe('confirmed');
    expect(snap.workflow?.state.kind === 'known' && snap.workflow.state.value).toBe('cancelled');

    // 3. History replay and stale generation frames are isolated
    const replayRes = observer.acceptFrame({
      ...pack.frames.canonicalPhases[0]!,
      channel: 'history_replay',
    });
    expect(replayRes.accepted).toBe(false);
    expect(replayRes.diagnostic?.code).toBe('history_replay_isolated');

    const staleGenRes = observer.acceptFrame({
      ...pack.frames.canonicalPhases[0]!,
      binding: { ...pack.binding, generation: asBindingGeneration('gen_stale_old') },
    });
    expect(staleGenRes.accepted).toBe(false);
    expect(staleGenRes.diagnostic?.code).toBe('stale_generation_rejected');

    // 4. Disconnect while stop requested marks workflow stale and stop unknown (never cancelled)
    const binding2 = makeBoostSyntheticBinding({ generation: asBindingGeneration('gen_np09_2') });
    observer.registerBinding({
      binding: binding2,
      connectionId: 'conn_np09_2',
      rootNativeSessionId: 'agy_sess_boost_002',
    });
    observer.recordConfirmedLaunch({
      binding: binding2,
      connectionId: 'conn_np09_2',
      originActivityId: asActivityId('act_boost_2'),
      observedAt: 1_700_000_100_000,
    });
    observer.handleStopRequested(binding2, { observedAt: 1_700_000_101_000 });
    const closedCommits = observer.handleTransportClosed(binding2, 'conn_np09_2', {
      observedAt: 1_700_000_102_000,
    });
    expect(closedCommits).toHaveLength(1);
    const snap2 = observer.getStudioSnapshot(binding2)!;
    expect(snap2.workflow?.state.kind).toBe('stale');
    expect(snap2.stop.state).toBe('unknown');
    expect(snap2.stop.reasonCode).toBe('stop_confirmation_lost_on_disconnect');
    const retiredCancel = {
      ...pack.frames.nativeCancelConfirmed,
      binding: binding2, connectionId: 'conn_np09_2', originSession: 'agy_sess_boost_002',
      wire: {
        method: 'session/update', params: { sessionId: 'agy_sess_boost_002',
          update: { sessionUpdate: 'boost_cancel_confirmed', status: 'cancelled' },
        },
      },
    };
    expect(observer.acceptFrame(retiredCancel).accepted).toBe(false);
    observer.registerBinding({ binding: binding2, connectionId: 'conn_np09_3',
      rootNativeSessionId: 'agy_sess_boost_002' });
    expect(observer.acceptFrame(retiredCancel).accepted).toBe(false);
    expect(observer.handleTransportClosed(binding2, 'conn_np09_2')).toEqual([]);
    expect(observer.getWorkflowState(binding2, snap2.workflow!.id)?.workflow.state.kind).toBe('stale');

  });
});
