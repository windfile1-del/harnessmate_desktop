import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  AGY_NATIVE_CONTRACT_VERSION,
  asActivityId,
  asBindingGeneration,
  asWorkId,
  type CapabilityDescriptor,
  type NativeWsServerFrame,
} from '@harnessmate/protocol';
import { FailoverCoordinator } from '../src/core/failover-service.js';
import { OrchestratorError, OrchestratorService } from '../src/core/orchestrator-service.js';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { AgyAdapter } from '../src/harnesses/agy/agy-driver.js';
import { DEFAULT_AGY_APP_DATA_DIR_NAME } from '../src/harnesses/agy/agy-launch-context.js';
import {
  AgyConsumerProvenanceError,
  assertAgyConsumerProvenance,
  evaluateAgyConsumerProvenance,
  mintAgyDispatchProvenance,
  type NativeLifecyclePort,
  type NativePermissionPort,
  type NativeTransportFrame,
  type NativeTurnSettlementSink,
} from '../src/harnesses/agy/native/wiring/index.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import type { HarnessAdapter, NormalizedAdapterEvent } from '../src/harnesses/types.js';
import { createDaemon } from '../src/server/app.js';

const tempDirs: string[] = [];
const openStores: HarnessMateStore[] = [];
const activeDaemons: Array<ReturnType<typeof createDaemon>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeCodexAdapter(id = 'codex'): HarnessAdapter {
  return {
    id,
    kind: 'codex',
    driverId: 'codex',
    displayName: 'Codex',
    description: 'Fake Codex',
    protocolLabel: 'fake',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['medium'],
      permissionModes: ['manual'],
      sessionResume: false,
      sessionFork: false,
      imageInput: false,
      subagents: false,
    },
    async probe() {
      return {
        id,
        kind: 'codex',
        driverId: 'codex',
        displayName: 'Codex',
        description: 'Fake Codex',
        protocolLabel: 'fake',
        binaryPath: 'codex',
        version: '1.0.0',
        health: 'ready',
        capabilities: this.capabilities,
        models: [],
        defaultModelId: null,
        accountSummary: null,
      };
    },
    async createSession() {
      throw new Error('not invoked in unit test');
    },
  };
}

function makeAgyAdapter(
  profilesRootDir: string,
  instanceId: string,
  authMethod: 'oauth-personal' | 'gemini-api-key' = 'oauth-personal',
  binaryOverride?: string,
): AgyAdapter {
  return new AgyAdapter({
    profile: {
      instanceId,
      displayName: `AGY (${instanceId})`,
      isolationMode: 'profile_isolated',
      authMethod,
      appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
      defaults: {
        linkGlobalSkills: false,
        syncGlobalRules: false,
        additionalDirectories: [],
      },
      enabled: true,
    },
    profilesRootDir,
    binaryOverride,
    applyWindowsAcl: false,
  });
}

afterEach(async () => {
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

describe('AGY consumer provenance policy & unforgeable guardrails (NP-02)', () => {
  it('rejects forged plain-object provenance and automated channels while allowing direct human & non-consumer targets', () => {
    const consumerTarget = {
      instanceId: 'agy',
      driverId: 'agy',
      authMethod: 'oauth-personal' as const,
    };

    const forged = { channel: 'human_direct', actor: 'desktop', issuedAt: Date.now() };
    const forgedDecision = evaluateAgyConsumerProvenance(consumerTarget, forged);
    expect(forgedDecision.allowed).toBe(false);
    expect(forgedDecision.channel).toBe('unverified_forged');
    expect(() => assertAgyConsumerProvenance(consumerTarget, forged)).toThrowError(
      AgyConsumerProvenanceError,
    );

    for (const ch of [
      'hm_orchestrator_delegation',
      'hm_orchestrator_wakeup',
      'auto_failover',
      'plugin_automated',
    ] as const) {
      const dec = evaluateAgyConsumerProvenance(
        consumerTarget,
        mintAgyDispatchProvenance(ch, 'system'),
      );
      expect(dec.allowed).toBe(false);
      expect(dec.code).toBe('CONSUMER_PROVENANCE_BLOCKED');
    }

    for (const ch of ['human_direct', 'manual_user_switch', 'agy_native_internal'] as const) {
      const dec = evaluateAgyConsumerProvenance(
        consumerTarget,
        mintAgyDispatchProvenance(ch, 'desktop'),
      );
      expect(dec.allowed).toBe(true);
    }

    expect(
      evaluateAgyConsumerProvenance(
        { instanceId: 'agy-api', driverId: 'agy', authMethod: 'gemini-api-key' },
        mintAgyDispatchProvenance('hm_orchestrator_delegation', 'system'),
      ).allowed,
    ).toBe(true);
    expect(
      evaluateAgyConsumerProvenance(
        { instanceId: 'codex', driverId: 'codex' },
        mintAgyDispatchProvenance('auto_failover', 'system'),
      ).allowed,
    ).toBe(true);
  });

  it('blocks Orchestrator delegation to consumer AGY and downgrades Codex->consumer-AGY auto-failover to manual', async () => {
    const tmp = makeTempDir('hm-np02-prov-');
    const store = new HarnessMateStore(path.join(tmp, 'hm.sqlite'));
    openStores.push(store);
    const registry = new HarnessRegistry();
    const codex = makeFakeCodexAdapter('codex');
    const agyConsumer = makeAgyAdapter(path.join(tmp, 'profiles'), 'agy-personal', 'oauth-personal');
    const agyApiKey = makeAgyAdapter(path.join(tmp, 'profiles'), 'agy-apikey', 'gemini-api-key');

    registry.register(codex);
    registry.register(agyConsumer);
    registry.register(agyApiKey);

    store.createWorkspace({
      id: 'ws_1',
      name: 'WS',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: Date.now(),
    });
    store.createSession({
      id: 'sess_parent',
      workspaceId: 'ws_1',
      harnessId: 'codex',
      harnessKind: 'codex',
      nativeSessionId: null,
      cwd: tmp,
      worktreeBranch: null,
      title: 'Parent',
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const orch = new OrchestratorService(store, registry);
    orch.attachHooks({
      isOrchestratorEnabled: () => true,
      getGitService: () => undefined,
      createChildSession: async () => {
        throw new Error('should not create child session');
      },
      sendTurn: async () => {},
      stopSession: async () => {},
      emitCanonical: () => {},
      publishAttention: () => {},
      getTaskLedger: () => undefined,
    });

    await expect(
      orch.delegateTask('sess_parent', {
        targetInstanceId: 'agy-personal',
        roleTitle: 'Background Worker',
        prompt: 'Inspect repo',
        isolation: 'read_only',
      }),
    ).rejects.toMatchObject({
      name: 'OrchestratorError',
      code: 'E_CONSUMER_PROVENANCE_BLOCKED',
    } satisfies Partial<OrchestratorError>);

    const failover = new FailoverCoordinator(store, registry, () => undefined);
    failover.setPolicy({
      mode: 'auto_any',
      priorityChain: ['agy-personal', 'agy-apikey'],
      maxAutoSwitchesPerSession: 2,
    });
    const recToConsumer = failover.recommendFailover('sess_parent', 'codex', 'rate_limited');
    expect(recToConsumer.recommendedInstanceId).toBe('agy-personal');
    expect(recToConsumer.canAutoFailover).toBe(false);
    expect(recToConsumer.downgradedToManualReason).toContain('个人 OAuth AGY');

    failover.setPolicy({
      mode: 'auto_any',
      priorityChain: ['agy-apikey'],
      maxAutoSwitchesPerSession: 2,
    });
    const recToApiKey = failover.recommendFailover('sess_parent', 'codex', 'rate_limited');
    expect(recToApiKey.recommendedInstanceId).toBe('agy-apikey');
    expect(recToApiKey.canAutoFailover).toBe(true);
  });
});

describe('AGY captured PromptContext, held settlement exit, transport tap & R1-R5 invariants (NP-02)', () => {
  it('prevents stale Turn 1 prompt response from settling Turn 2, isolates hook errors, and supports deferred single settlement via NativeTurnSettlementSink (R5)', async () => {
    const tmp = makeTempDir('hm-np02-acp-');
    const mockScript = path.join(tmp, 'mock-acp-r5.mjs');
    fs.writeFileSync(
      mockScript,
      `
import readline from 'node:readline';
let promptCount = 0;
let firstPromptId = null;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'mock-agy', version: '1.5.16' },
        agentCapabilities: { promptCapabilities: { embeddedContext: false } },
      },
    }) + '\\n');
    return;
  }
  if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId: 'nat_r5_1', configOptions: [] },
    }) + '\\n');
    return;
  }
  if (msg.method === 'session/prompt') {
    promptCount += 1;
    if (promptCount === 1) {
      firstPromptId = msg.id;
      return;
    }
    if (promptCount === 2) {
      // Send stale Turn 1 response while Turn 2 is active
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: firstPromptId,
        result: { stopReason: 'end_turn' },
      }) + '\\n');
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'nat_r5_1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Turn 2 answer' } },
          },
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn' },
        }) + '\\n');
      }, 30);
      return;
    }
    if (promptCount === 3) {
      // Quick prompt response for held-turn settlement test
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'nat_r5_1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started bg job' } },
        },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'end_turn' },
      }) + '\\n');
    }
  }
});
`,
      'utf8',
    );

    class ScriptAgyAdapter extends AgyAdapter {
      protected override buildLaunchArgs(): string[] {
        return [mockScript];
      }
    }

    const daemon = createDaemon({
      dataDir: path.join(tmp, 'data'),
      port: 0,
      webDistDir: null,
    });
    activeDaemons.push(daemon);

    const scriptAdapter = new ScriptAgyAdapter({
      profile: {
        instanceId: 'agy-r5',
        displayName: 'AGY R5',
        isolationMode: 'profile_isolated',
        authMethod: 'oauth-personal',
        appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
        defaults: { linkGlobalSkills: false, syncGlobalRules: false, additionalDirectories: [] },
        enabled: true,
      },
      profilesRootDir: path.join(tmp, 'profiles'),
      binaryOverride: process.execPath,
      applyWindowsAcl: false,
    });
    daemon.registry.register(scriptAdapter);

    // 1. Direct adapter test: stale Turn 1 response + throwing hook does NOT double-invoke failure callback!
    const frames: NativeTransportFrame[] = [];
    const settledLog: Array<{ turnId: string; ok: boolean; isCurrentTurn: boolean }> = [];
    let shouldThrowInHook = false;
    const dummyBinding = {
      runtimeId: 'nrt_r5_direct' as never,
      sessionId: 'sess_r5_direct',
      instanceId: 'agy-r5',
      generation: asBindingGeneration('gen_1'),
    };
    const handle = await scriptAdapter.createSession({
      cwd: tmp,
      permissionMode: 'manual',
      nativeRuntimeHooks: {
        binding: dummyBinding,
        getFeatureFlags: () => ({
          enabled: true,
          nativeLifecycle: true,
          nativePermissions: false,
          nativeCommands: false,
          observatoryTap: true,
          acpV2Preview: false,
        }),
        onTransportFrame: (frame) => frames.push(frame),
        onPromptSettled: (ctx, res) => {
          settledLog.push({ turnId: ctx.turnId, ok: res.ok, isCurrentTurn: res.isCurrentTurn });
          if (shouldThrowInHook) {
            throw new Error('simulated lifecycle hook exception');
          }
          return null;
        },
      },
    });
    const events: NormalizedAdapterEvent[] = [];
    handle.onEvent((ev) => events.push(ev));

    await handle.sendTurn({ turnId: 'turn_1', text: 'first prompt' });
    await handle.interrupt();
    shouldThrowInHook = true;
    await handle.sendTurn({ turnId: 'turn_2', text: 'second prompt' });
    await new Promise((r) => setTimeout(r, 150));

    // Turn 2 completed cleanly ONCE despite Turn 1 stale response AND despite hook throwing (no double invocation!)
    expect(
      events.filter((e) => e.type === 'turn.completed').map((e) => (e as { turnId: string }).turnId),
    ).toEqual(['turn_2']);
    expect(settledLog.filter((s) => s.turnId === 'turn_2')).toEqual([
      { turnId: 'turn_2', ok: true, isCurrentTurn: true },
    ]);
    expect(settledLog.find((s) => s.turnId === 'turn_1')?.isCurrentTurn).toBe(false);
    expect(frames.length).toBeGreaterThan(4);
    expect(handle.getConnectionId()).toMatch(/^conn_/);
    await handle.dispose();

    // 2. End-to-end SessionManager held-turn -> deferred single settlement via NativeTurnSettlementSink!
    const ws = daemon.store.createWorkspace({
      id: 'ws_r5',
      name: 'R5 WS',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: Date.now(),
    });
    const session = daemon.store.createSession({
      id: 'sess_r5',
      workspaceId: ws.id,
      harnessId: 'agy-r5',
      harnessKind: 'agy',
      nativeSessionId: null,
      cwd: tmp,
      worktreeBranch: null,
      title: 'R5 Held Settlement',
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Feature-OFF check (R4): opening a session while feature gate is OFF creates ZERO native_runtime_bindings rows!
    daemon.nativeRegistry.setFeatureFlags({ enabled: false, nativeLifecycle: false });
    expect(daemon.nativeRegistry.persistence.getLatestBindingForSession(session.id, 'agy-r5')).toBeNull();

    // Enable nativeLifecycle and attach a lifecycle port that holds turn_3 until explicitly released via sink!
    daemon.nativeRegistry.setFeatureFlags({ enabled: true, nativeLifecycle: true });
    let capturedSink: NativeTurnSettlementSink | null = null;
    let heldTurnId: string | null = null;
    let heldBinding = null as ReturnType<typeof daemon.nativeRegistry.getActiveBinding>;
    const heldLifecycle: NativeLifecyclePort = {
      attachSettlementSink(sink) {
        capturedSink = sink;
      },
      acceptFrame: () => {},
      acceptNativeObservation: () => {},
      handleTransportClosed: () => {},
      listRetentionReasons: () => (heldTurnId ? ['finite_work:wrk_bg_1'] : []),
      decideTurnSettlement: (tid) =>
        tid === heldTurnId
          ? { kind: 'held', reasonIds: ['finite_work:wrk_bg_1'] }
          : { kind: 'eligible', outcome: 'completed' },
      onPromptSettled: (ctx, res) => {
        if (res.ok && res.isCurrentTurn) {
          heldTurnId = ctx.turnId;
          heldBinding = ctx.binding;
          return { kind: 'held', reasonIds: ['finite_work:wrk_bg_1'] };
        }
        return { kind: 'eligible', outcome: 'completed' };
      },
    };
    daemon.nativeRegistry.registerModules({ lifecycle: heldLifecycle });
    expect(capturedSink).not.toBeNull();

    // Prime prompt 1 & 2 on the fresh scriptAdapter handle then prompt 3 -> returns quickly & gets held!
    const t1 = await daemon.sessionManager.sendTurn(session.id, 'p1');
    await daemon.sessionManager.interruptSession(session.id);
    const t2 = await daemon.sessionManager.sendTurn(session.id, 'p2');
    await new Promise((r) => setTimeout(r, 150));

    // Turn 2 is now held by lifecycle port -> session remains 'running' with zero turn.completed yet!
    expect(heldTurnId).toBe(t2.turnId);
    expect(daemon.store.getSession(session.id)?.status).toBe('running');
    const completedBeforeRelease = daemon.sessionManager
      .getSessionEvents(session.id, 0)
      .filter((e) => e.type === 'turn.completed' && e.turnId === t2.turnId);
    expect(completedBeforeRelease).toHaveLength(0);

    // Release held turn ONCE via NativeTurnSettlementSink -> settles cleanly and becomes 'idle'!
    const release1 = capturedSink!.settleTurn({
      binding: heldBinding!,
      turnId: t2.turnId,
      settlement: { kind: 'eligible', outcome: 'completed', stopReason: 'background_finished' },
    });
    expect(release1.settled).toBe(true);
    expect(daemon.store.getSession(session.id)?.status).toBe('idle');

    // Second release call is idempotently rejected (single settlement guarantee!)
    const release2 = capturedSink!.settleTurn({
      binding: heldBinding!,
      turnId: t2.turnId,
      settlement: { kind: 'eligible', outcome: 'completed', stopReason: 'duplicate' },
    });
    expect(release2.settled).toBe(false);
    const completedAfterRelease = daemon.sessionManager
      .getSessionEvents(session.id, 0)
      .filter((e) => e.type === 'turn.completed' && e.turnId === t2.turnId);
    expect(completedAfterRelease).toHaveLength(1);
    expect(t1.turnId).not.toBe(t2.turnId);
  }, 20_000);
});

describe('AGY REST/WS contracts: R2 concurrent idempotency & control/approval loops, R3 501-event WS replay & resync, R4 feature-off purity (NP-02)', () => {
  it('enforces R2 concurrent idempotency, closed-loop control & approval authorization, R4 feature-off purity, and R3 501-event complete WS replay', async () => {
    const tmp = makeTempDir('hm-np02-r234-');
    const daemon = createDaemon({
      dataDir: path.join(tmp, 'data'),
      port: 0,
      webDistDir: null,
    });
    activeDaemons.push(daemon);
    const { port } = await daemon.start();

    const ws = daemon.store.createWorkspace({
      id: 'ws_np02',
      name: 'NP02 WS',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: Date.now(),
    });
    const session = daemon.store.createSession({
      id: 'sess_np02',
      workspaceId: ws.id,
      harnessId: 'agy',
      harnessKind: 'agy',
      nativeSessionId: null,
      cwd: tmp,
      worktreeBranch: null,
      title: 'AGY Native Test',
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const codexSession = daemon.store.createSession({
      id: 'sess_codex',
      workspaceId: ws.id,
      harnessId: 'codex',
      harnessKind: 'codex',
      nativeSessionId: null,
      cwd: tmp,
      worktreeBranch: null,
      title: 'Codex Session',
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 1. Default feature-off: snapshot wrapped DTO returns Known Empty (enabled=false), writes return 503
    const snapOff = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/snapshot`,
    });
    expect(snapOff.statusCode).toBe(200);
    expect(snapOff.json().enabled).toBe(false);
    expect(snapOff.json().projection.enabled).toBe(false);
    expect(snapOff.json().projection.asOfSeq).toBe(0);

    // 2. Enable feature flags and wire controllable ports
    daemon.nativeRegistry.setFeatureFlags({
      enabled: true,
      nativeLifecycle: true,
      nativePermissions: true,
      nativeCommands: true,
    });

    const storedBinding = daemon.nativeRegistry.ensureRuntimeBinding({
      sessionId: session.id,
      instanceId: 'agy',
      profileRef: 'agy:default',
      status: 'attached',
    });
    const binding = {
      runtimeId: storedBinding.runtimeId,
      sessionId: storedBinding.sessionId,
      instanceId: storedBinding.instanceId,
      generation: storedBinding.generation,
    };

    let controlGate: CapabilityDescriptor['control'] = 'not_tested';
    let commandExecutions = 0;
    let controlExecutions = 0;
    let approvalExecutions = 0;
    let timelineCalls = 0;
    let workflowReaderCalls = 0;
    let releaseFirstCmd!: () => void;
    let throwNextCmd = false;

    const makeCaps = (): CapabilityDescriptor[] => [
      {
        id: 'agy.reactive.background',
        snapshotRevision: 3,
        surfaces: ['cli', 'acp'],
        advertised: true,
        launch: 'available',
        observe: 'available',
        control: controlGate,
        localRead: 'not_tested',
        actions: [
          { key: 'inspect', lane: 'query', gate: 'available' },
          { key: 'cancel', lane: 'live_workflow', gate: controlGate },
        ],
        evidenceRefs: ['E05'],
        verifiedLevel: 1,
      },
    ];

    const permStub: NativePermissionPort = {
      onIncomingRequest: () => null,
      onConnectionClosed: () => {},
      listPendingRequests: (b) =>
        b.generation === binding.generation
          ? [
              {
                approvalId: 'appr_native_1',
                runtimeId: binding.runtimeId,
                generation: binding.generation,
                connectionId: 'conn_priv_1',
                wireRequestId: 7,
                occurrence: 1,
                actualNativeSessionId: 'nat_priv_1',
                kind: 'permission',
                allowedOptionIds: ['allow_once', 'reject_once'],
              },
            ]
          : [],
      resolveNativeRequest: async ({ approvalId, receiptId }) => {
        approvalExecutions += 1;
        return {
          approvalId,
          receiptId,
          receiptState: 'response_written',
          conflict: false,
        };
      },
    };

    daemon.nativeRegistry.registerModules({
      permissions: permStub,
      timelineReader: {
        readTimeline: () => {
          timelineCalls += 1;
          return { revision: 1, items: [], nextPageToken: null, hasMore: false };
        },
      },
      workflowResourceReader: {
        readWorkflowResource: () => {
          workflowReaderCalls += 1;
          return {
            revision: 1,
            available: true,
            // Deliberately invalid item to test strict DTO outlet validation in R4!
            items: [{ leakedDebugPath: 'C:\\secret' } as unknown as never],
            nextPageToken: null,
            hasMore: false,
          };
        },
      },
      commandRouter: {
        getCapabilities: () => ({ capabilitiesRevision: 3, descriptors: makeCaps() }),
        executeCommand: async ({ receiptId }) => {
          commandExecutions += 1;
          if (throwNextCmd) {
            throw new Error('simulated transport write error');
          }
          await new Promise<void>((resolve) => {
            releaseFirstCmd = resolve;
          });
          return {
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            kind: 'inspect',
            receiptId,
            output: 'Concurrent inspect ok',
          };
        },
        executeControl: async ({ receiptId }) => {
          controlExecutions += 1;
          return {
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            receiptId,
            accepted: true,
            state: 'requested',
            revision: 2,
          };
        },
      },
    });

    // R2-A: Two CONCURRENT requests with same idempotencyKey -> ONLY ONE enters command port; second gets 409 BUSY!
    const req1Promise = daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: 3,
        capabilityId: 'agy.reactive.background',
        actionKey: 'inspect',
        idempotencyKey: 'idem_concurrent_1',
      },
    });
    // Wait a tick for req1 to claim DB receipt and suspend inside executeCommand
    await new Promise((r) => setTimeout(r, 20));
    const req2Res = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: 3,
        capabilityId: 'agy.reactive.background',
        actionKey: 'inspect',
        idempotencyKey: 'idem_concurrent_1',
      },
    });
    expect(req2Res.statusCode).toBe(409);
    expect(req2Res.json().code).toBe('BUSY');
    expect(commandExecutions).toBe(1);

    releaseFirstCmd();
    const req1Res = await req1Promise;
    expect(req1Res.statusCode).toBe(200);
    expect(req1Res.json().output).toBe('Concurrent inspect ok');

    // Replay after completion returns cached 200 without re-executing
    const req3Res = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: 3,
        capabilityId: 'agy.reactive.background',
        actionKey: 'inspect',
        idempotencyKey: 'idem_concurrent_1',
      },
    });
    expect(req3Res.statusCode).toBe(200);
    expect(commandExecutions).toBe(1);

    // Exception during command marks receipt `delivery_unknown` and blocks silent re-execution on same key
    throwNextCmd = true;
    const errCmd = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: 3,
        capabilityId: 'agy.reactive.background',
        actionKey: 'inspect',
        idempotencyKey: 'idem_err_1',
      },
    });
    expect(errCmd.statusCode).toBe(500);
    expect(errCmd.json().code).toBe('DELIVERY_UNKNOWN');
    const errCmdRetry = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: 3,
        capabilityId: 'agy.reactive.background',
        actionKey: 'inspect',
        idempotencyKey: 'idem_err_1',
      },
    });
    expect(errCmdRetry.statusCode).toBe(409);
    expect(errCmdRetry.json().code).toBe('DELIVERY_UNKNOWN');
    expect(commandExecutions).toBe(2);

    // R2-B: Closed-loop Control Authorization
    // 1) control is 'not_tested' -> 422 UNSUPPORTED_ACTION, port NEVER invoked!
    const ctrlDisabled = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/control`,
      payload: {
        generation: binding.generation,
        target: { type: 'work', id: 'wrk_missing' },
        action: 'cancel',
        expectedRevision: 1,
        idempotencyKey: 'ctrl_1',
      },
    });
    expect(ctrlDisabled.statusCode).toBe(422);
    expect(ctrlDisabled.json().code).toBe('UNSUPPORTED_ACTION');
    expect(controlExecutions).toBe(0);

    // 2) control is 'available', but target work does NOT exist -> 404 NOT_FOUND, port NEVER invoked!
    controlGate = 'available';
    const ctrlMissing = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/control`,
      payload: {
        generation: binding.generation,
        target: { type: 'work', id: 'wrk_missing' },
        action: 'cancel',
        expectedRevision: 1,
        idempotencyKey: 'ctrl_2',
      },
    });
    expect(ctrlMissing.statusCode).toBe(404);
    expect(ctrlMissing.json().code).toBe('NOT_FOUND');
    expect(controlExecutions).toBe(0);

    // 3) Create real work entity with revision 2 -> wrong expectedRevision gets 409 STALE_BINDING; matching revision succeeds!
    daemon.nativeRegistry.commitAndPublish(
      binding,
      {
        work: [
          {
            id: asWorkId('wrk_real_1'),
            kind: 'finite_command',
            blocking: 'confirmed_blocking',
            state: {
              kind: 'known',
              value: 'running',
              evidence: {
                kind: 'live_protocol',
                connectionId: 'conn_1',
                ingressOrdinal: 1,
                wireVariant: 'acp_v1',
                observedAt: Date.now(),
              },
            },
            revision: 2,
          },
        ],
      },
      {
        type: 'native.runtime.changed',
        turnId: null,
        payload: { status: 'attached', retentionReasons: ['finite_work:wrk_real_1'], revision: 1 },
      },
    );

    const ctrlWrongRev = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/control`,
      payload: {
        generation: binding.generation,
        target: { type: 'work', id: 'wrk_real_1' },
        action: 'cancel',
        expectedRevision: 1,
        idempotencyKey: 'ctrl_3',
      },
    });
    expect(ctrlWrongRev.statusCode).toBe(409);
    expect(ctrlWrongRev.json().code).toBe('STALE_BINDING');
    expect(controlExecutions).toBe(0);

    const ctrlOk = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/control`,
      payload: {
        generation: binding.generation,
        target: { type: 'work', id: 'wrk_real_1' },
        action: 'cancel',
        expectedRevision: 2,
        idempotencyKey: 'ctrl_4',
      },
    });
    expect(ctrlOk.statusCode).toBe(200);
    expect(controlExecutions).toBe(1);

    // R2-C: Closed-loop Approval Authorization & CAS
    // Unknown approvalId -> 404 NOT_FOUND, port NEVER invoked!
    const missingPerm = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/appr_does_not_exist/resolve`,
      payload: { generation: binding.generation, outcome: 'selected', optionId: 'allow_once' },
    });
    expect(missingPerm.statusCode).toBe(404);
    expect(approvalExecutions).toBe(0);

    // Valid approval resolves ONCE; second resolve loses DB CAS -> 409 ALREADY_RESOLVED, port NOT invoked again!
    const okPerm = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/appr_native_1/resolve`,
      payload: { generation: binding.generation, outcome: 'selected', optionId: 'allow_once' },
    });
    expect(okPerm.statusCode).toBe(200);
    expect(approvalExecutions).toBe(1);

    const dupPerm = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/appr_native_1/resolve`,
      payload: { generation: binding.generation, outcome: 'selected', optionId: 'allow_once' },
    });
    expect(dupPerm.statusCode).toBe(409);
    expect(dupPerm.json().code).toBe('ALREADY_RESOLVED');
    expect(approvalExecutions).toBe(1);

    // R4: Strict workflow resource DTO outlet rejects arbitrary debug fields from reader port
    const badWfOutlet = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/workflows/wf_1/board`,
    });
    expect(badWfOutlet.statusCode).toBe(500);

    // R4: Toggling feature gate OFF after writes returns Known Empty, default not_tested caps, and never invokes reader ports!
    daemon.nativeRegistry.setFeatureFlags({ enabled: false });
    const snapAfterOff = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/snapshot`,
    });
    expect(snapAfterOff.statusCode).toBe(200);
    expect(snapAfterOff.json().enabled).toBe(false);
    expect(snapAfterOff.json().projection.status).toBe('disconnected');
    expect(snapAfterOff.json().projection.asOfSeq).toBe(0);
    expect(snapAfterOff.json().projection.work).toEqual([]);

    const capsAfterOff = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/capabilities`,
    });
    expect(capsAfterOff.statusCode).toBe(200);
    expect(capsAfterOff.json().enabled).toBe(false);
    expect(capsAfterOff.json().descriptors.every((d: CapabilityDescriptor) => d.control === 'not_tested')).toBe(true);

    const tlCallsBefore = timelineCalls;
    const wfCallsBefore = workflowReaderCalls;
    const tlOff = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/activity/act_1/timeline`,
    });
    expect(tlOff.statusCode).toBe(200);
    expect(tlOff.json().sourceUnavailableReason).toBe('native_runtime_disabled');
    expect(timelineCalls).toBe(tlCallsBefore);

    const wfOff = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/workflows/wf_1/board`,
    });
    expect(wfOff.statusCode).toBe(200);
    expect(wfOff.json().available).toBe(false);
    expect(workflowReaderCalls).toBe(wfCallsBefore);

    // R3: Re-enable and pre-populate 501 total events (seq 1..501), verify WS replays ALL 501 + live 502 with ZERO gaps!
    daemon.nativeRegistry.setFeatureFlags({ enabled: true });
    for (let i = 2; i <= 501; i += 1) {
      daemon.nativeRegistry.commitAndPublish(
        binding,
        {},
        {
          type: 'native.runtime.changed',
          turnId: null,
          payload: { status: 'attached', retentionReasons: [], revision: i },
        },
      );
    }

    const receivedSeqs: number[] = [];
    let replayCompleteSeq: number | null = null;
    let resyncReason: string | null = null;

    await new Promise<void>((resolve, reject) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/sessions/${session.id}/native/ws?token=${encodeURIComponent(daemon.config.localToken)}`,
      );
      client.on('error', reject);
      client.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8')) as NativeWsServerFrame;
        if (frame.op === 'native_hello') {
          client.send(JSON.stringify({ op: 'subscribe_native', schemaVersion: 1, afterSeq: 0 }));
        } else if (frame.op === 'native_event') {
          receivedSeqs.push(frame.event.seq);
          if (frame.event.seq === 502) {
            // Now change runtimeId (profile change) and emit event -> WS MUST send native_resync_required!
            const newBindingStored = daemon.nativeRegistry.ensureRuntimeBinding({
              sessionId: session.id,
              instanceId: 'agy',
              profileRef: 'agy:profile:switched',
              status: 'attached',
            });
            daemon.nativeRegistry.commitAndPublish(
              {
                runtimeId: newBindingStored.runtimeId,
                sessionId: newBindingStored.sessionId,
                instanceId: newBindingStored.instanceId,
                generation: newBindingStored.generation,
              },
              {},
              {
                type: 'native.runtime.changed',
                turnId: null,
                payload: { status: 'attached', retentionReasons: [], revision: 1 },
              },
            );
          }
        } else if (frame.op === 'native_replay_complete') {
          replayCompleteSeq = frame.lastSeq;
          // Emit live event 502 after complete replay
          daemon.nativeRegistry.commitAndPublish(
            binding,
            {},
            {
              type: 'native.runtime.changed',
              turnId: null,
              payload: { status: 'attached', retentionReasons: [], revision: 502 },
            },
          );
        } else if (frame.op === 'native_resync_required') {
          resyncReason = frame.reason;
          client.close();
          resolve();
        }
      });
    });

    expect(replayCompleteSeq).toBe(501);
    expect(receivedSeqs).toHaveLength(502);
    expect(receivedSeqs[0]).toBe(1);
    expect(receivedSeqs[500]).toBe(501);
    expect(receivedSeqs[501]).toBe(502);
    expect(resyncReason).toBe('runtime_changed');

    // R3: WS upgrade rejects non-AGY session (422) cleanly
    await expect(
      new Promise<void>((_, reject) => {
        const badWs = new WebSocket(
          `ws://127.0.0.1:${port}/api/v1/sessions/${codexSession.id}/native/ws?token=${encodeURIComponent(daemon.config.localToken)}`,
        );
        badWs.on('unexpected-response', (_req, res) => {
          reject(new Error(`HTTP_${res.statusCode}`));
        });
        badWs.on('error', reject);
      }),
    ).rejects.toThrow('HTTP_422');

    // Verify forged provenance rejection in SessionManager.sendTurn
    await expect(
      daemon.sessionManager.sendTurn(session.id, 'forged automated prompt', undefined, {
        dispatchProvenance: {
          channel: 'human_direct',
          actor: 'desktop',
          issuedAt: Date.now(),
        } as unknown as ReturnType<typeof mintAgyDispatchProvenance>,
      }),
    ).rejects.toThrowError(AgyConsumerProvenanceError);

    // Verify newer-than-reader DB closes native routes (503) while preserving legacy GET /sessions/:id (200)
    await daemon.stop();
    activeDaemons.pop();
    const reopenedRaw = new HarnessMateStore(path.join(tmp, 'data', 'harnessmate.db'));
    reopenedRaw
      .getDatabaseSync()
      .prepare("UPDATE component_schema_migrations SET version = 99 WHERE component = 'agy-native-runtime'")
      .run();
    reopenedRaw.close();

    const daemonNewer = createDaemon({
      dataDir: path.join(tmp, 'data'),
      port: 0,
      webDistDir: null,
    });
    activeDaemons.push(daemonNewer);
    await daemonNewer.start();

    const legacyGet = await daemonNewer.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}`,
    });
    expect(legacyGet.statusCode).toBe(200);
    expect(legacyGet.json().session.id).toBe(session.id);

    const nativeNewer = await daemonNewer.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/snapshot`,
    });
    expect(nativeNewer.statusCode).toBe(503);
    expect(nativeNewer.json().code).toBe('NATIVE_SCHEMA_NEWER_THAN_READER');
  }, 20_000);
});
