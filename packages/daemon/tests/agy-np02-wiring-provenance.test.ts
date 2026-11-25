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

    // Forged plain object mimicking human_direct MUST fail
    const forged = { channel: 'human_direct', actor: 'desktop', issuedAt: Date.now() };
    const forgedDecision = evaluateAgyConsumerProvenance(consumerTarget, forged);
    expect(forgedDecision.allowed).toBe(false);
    expect(forgedDecision.channel).toBe('unverified_forged');
    expect(() => assertAgyConsumerProvenance(consumerTarget, forged)).toThrowError(
      AgyConsumerProvenanceError,
    );

    // Automated channels MUST fail for consumer OAuth AGY
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

    // Verified human_direct / manual_user_switch / agy_native_internal MUST pass
    for (const ch of ['human_direct', 'manual_user_switch', 'agy_native_internal'] as const) {
      const dec = evaluateAgyConsumerProvenance(
        consumerTarget,
        mintAgyDispatchProvenance(ch, 'desktop'),
      );
      expect(dec.allowed).toBe(true);
    }

    // Non-consumer AGY (API key) and non-AGY (codex) are not blocked by consumer OAuth guard
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

    // 1. Orchestrator must reject delegating a subagent to consumer OAuth AGY
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

    // 2. FailoverCoordinator must downgrade Codex -> consumer OAuth AGY to manual even under auto policy
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

    // Whereas failing over to non-consumer API-key AGY is permitted under auto_any
    failover.setPolicy({
      mode: 'auto_any',
      priorityChain: ['agy-apikey'],
      maxAutoSwitchesPerSession: 2,
    });
    const recToApiKey = failover.recommendFailover('sess_parent', 'codex', 'rate_limited');
    expect(recToApiKey.recommendedInstanceId).toBe('agy-apikey');
    expect(recToApiKey.canAutoFailover).toBe(true);

    store.close();
  });
});

describe('AGY captured PromptContext, transport tap, REST/WS native feed & feature-off regression (NP-02)', () => {
  it('prevents stale Turn 1 prompt response from settling Turn 2 and preserves RPC ID types & transport tap', async () => {
    const tmp = makeTempDir('hm-np02-acp-');
    const mockScript = path.join(tmp, 'mock-acp-stale.mjs');
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
      result: { sessionId: 'nat_stale_1', configOptions: [] },
    }) + '\\n');
    return;
  }
  if (msg.method === 'session/prompt') {
    promptCount += 1;
    if (promptCount === 1) {
      firstPromptId = msg.id;
      // Hold Turn 1 response until Turn 2 arrives
      return;
    }
    if (promptCount === 2) {
      // First send the STALE response for Turn 1 while Turn 2 is active!
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: firstPromptId,
        result: { stopReason: 'end_turn' },
      }) + '\\n');
      // Then emit Turn 2 assistant message & completion shortly after
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'nat_stale_1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Turn 2 answer' } },
          },
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn' },
        }) + '\\n');
      }, 40);
    }
  }
});
`,
      'utf8',
    );

    const adapter = makeAgyAdapter(path.join(tmp, 'profiles'), 'agy-test', 'oauth-personal', process.execPath);
    // Point args to our mock node script by overriding protected args via subclass
    class ScriptAgyAdapter extends AgyAdapter {
      protected override buildLaunchArgs(): string[] {
        return [mockScript];
      }
    }
    const scriptAdapter = new ScriptAgyAdapter({
      profile: adapter.getProfile(),
      profilesRootDir: path.join(tmp, 'profiles'),
      binaryOverride: process.execPath,
      applyWindowsAcl: false,
    });

    const frames: NativeTransportFrame[] = [];
    const settledPrompts: string[] = [];
    const binding = {
      runtimeId: 'nrt_test' as never,
      sessionId: 'sess_test',
      instanceId: 'agy-test',
      generation: asBindingGeneration('gen_1'),
    };

    const handle = await scriptAdapter.createSession({
      cwd: tmp,
      permissionMode: 'manual',
      nativeRuntimeHooks: {
        binding,
        getFeatureFlags: () => ({
          enabled: true,
          nativeLifecycle: true,
          nativePermissions: false,
          nativeCommands: false,
          observatoryTap: true,
          acpV2Preview: false,
        }),
        onTransportFrame: (frame) => frames.push(frame),
        onPromptSettled: (ctx) => {
          settledPrompts.push(ctx.turnId);
          return null;
        },
      },
    });

    const events: NormalizedAdapterEvent[] = [];
    handle.onEvent((ev) => events.push(ev));

    await handle.sendTurn({ turnId: 'turn_1', text: 'first prompt' });
    await handle.interrupt();
    await handle.sendTurn({ turnId: 'turn_2', text: 'second prompt' });

    await new Promise((r) => setTimeout(r, 150));

    const completedTurnIds = events
      .filter((e): e is Extract<NormalizedAdapterEvent, { type: 'turn.completed' }> => e.type === 'turn.completed')
      .map((e) => e.turnId);
    const completedTexts = events
      .filter(
        (e): e is Extract<NormalizedAdapterEvent, { type: 'message.assistant.completed' }> =>
          e.type === 'message.assistant.completed',
      )
      .map((e) => ({ turnId: e.turnId, text: e.text }));

    // Turn 1's stale response did NOT prematurely settle Turn 2; Turn 2 completed with its actual text!
    expect(completedTurnIds).toEqual(['turn_2']);
    expect(completedTexts).toEqual([{ turnId: 'turn_2', text: 'Turn 2 answer' }]);
    // Both prompt contexts were observed by native lifecycle
    expect(settledPrompts).toContain('turn_1');
    expect(settledPrompts).toContain('turn_2');
    // Transport observatory saw monotonic frames with a connectionId
    expect(frames.length).toBeGreaterThan(4);
    expect(handle.getConnectionId()).toMatch(/^conn_/);

    await handle.dispose();
  }, 15_000);

  it('serves feature-off Known Empty, feature-on REST endpoints, 410 RESYNC_REQUIRED, permission validation, and dedicated WS feed', async () => {
    const tmp = makeTempDir('hm-np02-daemon-');
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

    // 1. Default feature-off: snapshot returns Known Empty (enabled=false), writes return 503 NATIVE_RUNTIME_DISABLED
    const snapOff = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/snapshot`,
    });
    expect(snapOff.statusCode).toBe(200);
    expect(snapOff.json().enabled).toBe(false);
    expect(snapOff.json().asOfSeq).toBe(0);

    const capsOff = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/capabilities`,
    });
    expect(capsOff.statusCode).toBe(200);
    expect(capsOff.json().enabled).toBe(false);

    const cmdOff = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: 'gen_0',
        catalogRevision: 0,
        capabilityId: 'agy.workflow.goal',
        actionKey: 'launch',
        idempotencyKey: 'k1',
      },
    });
    expect(cmdOff.statusCode).toBe(503);
    expect(cmdOff.json().code).toBe('NATIVE_RUNTIME_DISABLED');

    // 2. Enable native flags and register minimal stub modules
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
    });
    const binding = {
      runtimeId: storedBinding.runtimeId,
      sessionId: storedBinding.sessionId,
      instanceId: storedBinding.instanceId,
      generation: storedBinding.generation,
    };

    const sampleCap: CapabilityDescriptor = {
      id: 'agy.workflow.goal',
      snapshotRevision: 3,
      surfaces: ['cli', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'not_tested',
      localRead: 'not_tested',
      actions: [{ key: 'inspect', lane: 'query', gate: 'available' }],
      evidenceRefs: ['E05'],
      verifiedLevel: 1,
    };

    let commandExecutions = 0;
    const permStub: NativePermissionPort = {
      onIncomingRequest: () => null,
      onConnectionClosed: () => {},
      listPendingRequests: () => [
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
      ],
      resolveNativeRequest: async ({ approvalId }) => ({
        approvalId,
        receiptId: 'nrcpt_perm_1',
        receiptState: 'response_written',
        conflict: false,
      }),
    };
    const lifecycleStub: NativeLifecyclePort = {
      acceptFrame: () => {},
      acceptNativeObservation: () => {},
      handleTransportClosed: () => {},
      listRetentionReasons: () => ['finite_work:wrk_1'],
      decideTurnSettlement: () => ({ kind: 'held', reasonIds: ['finite_work:wrk_1'] }),
    };

    daemon.nativeRegistry.registerModules({
      lifecycle: lifecycleStub,
      permissions: permStub,
      commandRouter: {
        getCapabilities: () => ({ capabilitiesRevision: 3, descriptors: [sampleCap] }),
        executeCommand: async ({ receiptId }) => {
          commandExecutions += 1;
          return {
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            kind: 'inspect',
            receiptId,
            output: 'Goal inspect ok',
          };
        },
        executeControl: async ({ receiptId }) => ({
          schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
          receiptId,
          accepted: true,
          state: 'requested',
          revision: 1,
        }),
      },
    });

    // Commit an event and verify GET /events + cursor + 410 RESYNC_REQUIRED
    const committed = daemon.nativeRegistry.commitAndPublish(
      binding,
      {
        activities: [
          {
            id: asActivityId('act_1'),
            turnId: null,
            origin: 'native_continuation',
            workId: asWorkId('wrk_1'),
            state: 'running',
            updatedAt: Date.now(),
          },
        ],
        status: 'attached',
        retentionReasons: ['finite_work:wrk_1'],
      },
      {
        type: 'native.runtime.changed',
        turnId: null,
        payload: {
          status: 'attached',
          retentionReasons: ['finite_work:wrk_1'],
          revision: 1,
        },
      },
    );
    expect(committed.event.seq).toBe(1);

    const evRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/events?after=0&limit=10`,
    });
    expect(evRes.statusCode).toBe(200);
    expect(evRes.json().events).toHaveLength(1);
    expect(evRes.json().nextSeq).toBe(1);

    const staleEvRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/events?generation=gen_stale`,
    });
    expect(staleEvRes.statusCode).toBe(410);
    expect(staleEvRes.json().code).toBe('RESYNC_REQUIRED');

    // Command validation: stale catalog revision -> 409, idempotency replay -> single execution, conflict -> 409
    const staleCmd = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: 0,
        capabilityId: 'agy.workflow.goal',
        actionKey: 'inspect',
        idempotencyKey: 'cmd_stale',
      },
    });
    expect(staleCmd.statusCode).toBe(409);
    expect(staleCmd.json().code).toBe('STALE_BINDING');

    const okCmd1 = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: 3,
        capabilityId: 'agy.workflow.goal',
        actionKey: 'inspect',
        args: { filter: 'active' },
        idempotencyKey: 'cmd_ok_1',
      },
    });
    expect(okCmd1.statusCode).toBe(200);
    expect(okCmd1.json().output).toBe('Goal inspect ok');

    // Replay same key + same payload returns cached response without re-executing
    const okCmdReplay = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: 3,
        capabilityId: 'agy.workflow.goal',
        actionKey: 'inspect',
        args: { filter: 'active' },
        idempotencyKey: 'cmd_ok_1',
      },
    });
    expect(okCmdReplay.statusCode).toBe(200);
    expect(commandExecutions).toBe(1);

    // Same key + different payload returns 409 IDEMPOTENCY_CONFLICT
    const conflictCmd = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: 3,
        capabilityId: 'agy.workflow.goal',
        actionKey: 'inspect',
        args: { filter: 'different' },
        idempotencyKey: 'cmd_ok_1',
      },
    });
    expect(conflictCmd.statusCode).toBe(409);
    expect(conflictCmd.json().code).toBe('IDEMPOTENCY_CONFLICT');

    // Permission input validation: invalid optionId not in allowedOptionIds -> 400
    const badPerm = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/appr_native_1/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_everything_forged',
      },
    });
    expect(badPerm.statusCode).toBe(400);
    expect(badPerm.json().code).toBe('INVALID_REQUEST');

    const okPerm = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/appr_native_1/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
    expect(okPerm.statusCode).toBe(200);
    expect(okPerm.json().receiptState).toBe('response_written');

    // Dedicated WS native feed (/api/v1/sessions/:id/native/ws): replay + live stream
    const wsFrames: NativeWsServerFrame[] = [];
    await new Promise<void>((resolve, reject) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/sessions/${session.id}/native/ws?token=${encodeURIComponent(daemon.config.localToken)}`,
      );
      client.on('error', reject);
      client.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8')) as NativeWsServerFrame;
        wsFrames.push(frame);
        if (frame.op === 'native_hello') {
          client.send(
            JSON.stringify({
              op: 'subscribe_native',
              schemaVersion: 1,
              afterSeq: 0,
            }),
          );
        } else if (frame.op === 'native_replay_complete') {
          // Trigger a live native event after replay completes
          daemon.nativeRegistry.commitAndPublish(
            binding,
            { status: 'attached', retentionReasons: [] },
            {
              type: 'native.runtime.changed',
              turnId: null,
              payload: { status: 'attached', retentionReasons: [], revision: 2 },
            },
          );
        } else if (frame.op === 'native_event' && frame.event.seq === 2) {
          client.close();
          resolve();
        }
      });
    });

    expect(wsFrames.some((f) => f.op === 'native_hello' && f.enabled === true)).toBe(true);
    expect(wsFrames.some((f) => f.op === 'native_event' && f.event.seq === 1)).toBe(true);
    expect(wsFrames.some((f) => f.op === 'native_replay_complete' && f.lastSeq === 1)).toBe(true);
    expect(wsFrames.some((f) => f.op === 'native_event' && f.event.seq === 2)).toBe(true);

    // SessionManager.sendTurn rejects forged provenance object on consumer AGY
    await expect(
      daemon.sessionManager.sendTurn(session.id, 'forged automated prompt', undefined, {
        dispatchProvenance: {
          channel: 'human_direct',
          actor: 'desktop',
          issuedAt: Date.now(),
        } as unknown as ReturnType<typeof mintAgyDispatchProvenance>,
      }),
    ).rejects.toThrowError(AgyConsumerProvenanceError);

    // Newer-than-reader DB closes native routes (503) while keeping legacy /api/v1/sessions/:id readable (200)
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
  });
});
