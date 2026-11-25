import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGY_NATIVE_CONTRACT_VERSION,
  asActivityId,
  asBindingGeneration,
  asRuntimeId,
  type Session,
} from '@harnessmate/protocol';
import { HarnessCommandTools, listHarnessCommands } from '../src/core/harness-commands.js';
import {
  AgyInteractiveWorkflowFallbackError,
  inspectAgyCommand,
  isInteractiveWorkflowSlashCommand,
  runAgyCommand,
} from '../src/harnesses/agy-commands.js';
import { AgyAdapter } from '../src/harnesses/agy/agy-driver.js';
import { DEFAULT_AGY_APP_DATA_DIR_NAME } from '../src/harnesses/agy/agy-launch-context.js';
import {
  AgyNativeCommandCatalogService,
  AgyNativeCommandRouter,
  NativeCommandRouterError,
  SYNTHETIC_ACP_COMMANDS_FULL,
  SYNTHETIC_ACP_COMMANDS_WITH_UNKNOWN,
  SYNTHETIC_CONFIG_OPTIONS_FLASH,
  makeSyntheticBinding,
  makeSyntheticVerifiedSignals,
  type LiveWorkflowDispatchInput,
} from '../src/harnesses/agy/native/commands/index.js';
import { mintAgyDispatchProvenance } from '../src/harnesses/agy/native/wiring/provenance.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import { createDaemon } from '../src/server/app.js';

const tempDirs: string[] = [];
const activeDaemons: Array<ReturnType<typeof createDaemon>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createFakeAgyCliScript(
  dir: string,
  callsLogPath: string,
  profileBDir: string,
): string {
  const scriptPath = path.join(dir, 'fake-agy-cli.mjs');
  fs.writeFileSync(
    scriptPath,
    `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const geminiHome = process.env.GEMINI_HOME || '';
const isProfileB = geminiHome && path.resolve(geminiHome).toLowerCase() === path.resolve(${JSON.stringify(profileBDir)}).toLowerCase();
fs.appendFileSync(
  ${JSON.stringify(callsLogPath)},
  JSON.stringify({ args, geminiHome, cwd: process.cwd() }) + '\\n',
);
const idxP = args.indexOf('-p');
const cmd = idxP >= 0 ? args[idxP + 1] : '';
if (cmd === '/usage') {
  process.stdout.write(JSON.stringify({
    status: 'OK',
    command: {
      name: 'usage',
      data: {
        tier: isProfileB ? 'Ultra' : 'Pro',
        groups: [{
          id: 'gemini',
          name: 'Gemini',
          buckets: [{ name: isProfileB ? 'AcctB-Bucket' : 'AcctA-Bucket', window: '5h', remaining_fraction: 0.85 }],
        }],
      },
    },
  }) + '\\n');
  process.exit(0);
}
if (cmd === '/skills') {
  const skills = isProfileB
    ? [{ name: 'profile-b-skill', description: 'Only in Profile B', enabled: true }]
    : [{ name: 'profile-a-skill', description: 'Only in Profile A', enabled: true }];
  process.stdout.write(JSON.stringify({
    status: 'OK',
    command: { name: 'skills', data: { skills } },
  }) + '\\n');
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ plugins: [], geminiHome }) + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected command: ' + args.join(' '));
process.exit(1);
`,
    'utf8',
  );

  if (process.platform === 'win32') {
    const cmdPath = path.join(dir, 'fake-agy.cmd');
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  const shPath = path.join(dir, 'fake-agy.sh');
  fs.writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

function makeIsolatedAgyAdapter(
  profilesRoot: string,
  instanceId: string,
  binaryPath: string,
  withToken = true,
): AgyAdapter {
  const adapter = new AgyAdapter({
    profile: {
      instanceId,
      displayName: `AGY ${instanceId}`,
      isolationMode: 'profile_isolated',
      authMethod: 'oauth-personal',
      appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
      defaults: {
        linkGlobalSkills: false,
        syncGlobalRules: false,
        additionalDirectories: [],
      },
      enabled: true,
    },
    profilesRootDir: profilesRoot,
    binaryOverride: binaryPath,
    applyWindowsAcl: false,
  });
  adapter.ensureProfilePrepared();
  if (withToken) {
    const ctx = adapter.getLaunchContextSync(binaryPath);
    fs.mkdirSync(path.dirname(ctx.tokenFilePath), { recursive: true });
    fs.writeFileSync(ctx.tokenFilePath, '{"synthetic":true}', 'utf8');
  }
  return adapter;
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const daemon = activeDaemons.pop();
    await daemon?.stop().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

describe('NP-06 Capability Discovery & Per-Binding Command Catalog (synthetic T01/T15)', () => {
  it('tracks advertised -> revoked -> empty broadcast transitions, bumps revisions, and disables unknown dynamic slashes', () => {
    const catalog = new AgyNativeCommandCatalogService();
    const binding = makeSyntheticBinding();

    // 1. Before any broadcast, dynamic workflow commands are unknown (advertised: null)
    const initial = catalog.getSnapshot(binding);
    expect(initial.capabilitiesRevision).toBe(0);
    const swarmBefore = initial.descriptors.find((d) => d.id === 'AGY-W04');
    expect(swarmBefore?.advertised).toBeNull();
    expect(swarmBefore?.launch).toBe('not_tested');

    // 2. Runtime advertises commands including an unknown dynamic slash command
    const afterBroadcast = catalog.updateBindingSignals(
      binding,
      makeSyntheticVerifiedSignals({
        advertisedCommands: SYNTHETIC_ACP_COMMANDS_WITH_UNKNOWN,
      }),
    );
    expect(afterBroadcast.snapshot.capabilitiesRevision).toBe(1);
    const goalAfter = afterBroadcast.snapshot.descriptors.find((d) => d.id === 'AGY-W09');
    const swarmAfter = afterBroadcast.snapshot.descriptors.find((d) => d.id === 'AGY-W04');
    const unknownDyn = afterBroadcast.snapshot.descriptors.find(
      (d) => d.id === 'AGY-DYN-mystery-tui-slash',
    );
    expect(goalAfter?.advertised).toBe(true);
    expect(goalAfter?.actions[0]?.gate).toBe('available');
    expect(swarmAfter?.advertised).toBe(true);
    expect(swarmAfter?.actions[0]?.gate).toBe('available');
    expect(unknownDyn?.advertised).toBe(true);
    expect(unknownDyn?.launch).toBe('unsupported');
    expect(unknownDyn?.actions[0]?.gate).toBe('unsupported');
    expect(unknownDyn?.actions[0]?.reasonCode).toBe('unknown_dynamic_slash_disabled');

    // 3. Revocation: subsequent update omits `swarm` -> degrades to unsupported and bumps revision
    const afterRevoke = catalog.applyAdvertisedCommandsUpdate(binding, [{ name: 'plan' }, { name: 'goal' }]);
    expect(afterRevoke.snapshot.capabilitiesRevision).toBe(2);
    expect(afterRevoke.changedDescriptorIds).toContain('AGY-W04');
    const swarmRevoked = afterRevoke.snapshot.descriptors.find((d) => d.id === 'AGY-W04');
    expect(swarmRevoked?.advertised).toBe(false);
    expect(swarmRevoked?.actions[0]?.gate).toBe('unsupported');
    expect(swarmRevoked?.actions[0]?.reasonCode).toBe('command_not_advertised_or_revoked');

    // 4. Empty array broadcast `[]` is treated as explicit revocation of all dynamic commands
    const afterEmpty = catalog.applyAdvertisedCommandsUpdate(binding, []);
    expect(afterEmpty.snapshot.capabilitiesRevision).toBe(3);
    const goalRevoked = afterEmpty.snapshot.descriptors.find((d) => d.id === 'AGY-W09');
    expect(goalRevoked?.advertised).toBe(false);
    expect(goalRevoked?.actions[0]?.gate).toBe('unsupported');
  });

  it('isolates catalog and model/effort caches across dual accounts and different binding generations (T15)', () => {
    const catalog = new AgyNativeCommandCatalogService();
    const bindingA = makeSyntheticBinding({
      runtimeId: 'nrt_acct_a',
      sessionId: 'sess_a',
      instanceId: 'agy-acct-a',
      generation: 'gen_1',
    });
    const bindingB = makeSyntheticBinding({
      runtimeId: 'nrt_acct_b',
      sessionId: 'sess_b',
      instanceId: 'agy-acct-b',
      generation: 'gen_1',
    });

    catalog.updateBindingSignals(
      bindingA,
      makeSyntheticVerifiedSignals({
        profileRef: 'agy:profile:acct-a',
        tierName: 'Pro',
        advertisedCommands: [{ name: 'swarm' }, { name: 'boost' }],
        configOptions: SYNTHETIC_CONFIG_OPTIONS_FLASH,
      }),
    );
    catalog.updateBindingSignals(
      bindingB,
      makeSyntheticVerifiedSignals({
        profileRef: 'agy:profile:acct-b',
        tierName: 'Free',
        advertisedCommands: [{ name: 'goal' }],
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'gemini-3.8-flash',
            options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
          },
        ],
        observedModels: [{ id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' }],
      }),
    );

    const snapA = catalog.getSnapshot(bindingA);
    const snapB = catalog.getSnapshot(bindingB);

    expect(snapA.cacheKey).not.toBe(snapB.cacheKey);
    expect(snapA.descriptors.find((d) => d.id === 'AGY-W04')?.actions[0]?.gate).toBe('available');
    expect(snapA.descriptors.find((d) => d.id === 'AGY-W06')?.actions[0]?.gate).toBe('available');
    expect(snapA.modelEffortOptions.availableEfforts).toEqual(['low', 'medium', 'high']);

    // Account B has Free tier, no swarm/boost advertisement, and no observed effort options
    expect(snapB.descriptors.find((d) => d.id === 'AGY-W04')?.actions[0]?.gate).toBe('unsupported');
    expect(snapB.descriptors.find((d) => d.id === 'AGY-W06')?.actions[0]?.gate).toBe('unsupported');
    expect(snapB.descriptors.find((d) => d.id === 'AGY-W09')?.actions[0]?.gate).toBe('available');
    expect(snapB.modelEffortOptions.effortObserved).toBe(false);
    expect(snapB.descriptors.find((d) => d.id === 'AGY-S12')?.actions[0]?.gate).toBe('unknown');
  });

  it('allows NP-08..NP-12 to contribute workflow descriptors without adding a separate global executor', () => {
    const catalog = new AgyNativeCommandCatalogService();
    const unregister = catalog.registerWorkflowDescriptor({
      contributorId: 'np08-swarm-observer',
      capabilityId: 'AGY-W04',
      versionNote: 'NP-08 verified coordinator stream',
      evidenceRefs: ['SYNTH-NP08'],
      observeGateOverride: 'available',
    });

    const binding = makeSyntheticBinding();
    catalog.updateBindingSignals(binding, makeSyntheticVerifiedSignals());
    const swarm = catalog.getSnapshot(binding).descriptors.find((d) => d.id === 'AGY-W04');
    expect(swarm?.observe).toBe('available');
    expect(swarm?.versionNote).toBe('NP-08 verified coordinator stream');
    expect(swarm?.evidenceRefs).toContain('SYNTH-NP08');

    unregister();
    const afterUnreg = catalog.updateBindingSignals(binding, { tierName: 'Ultra' });
    expect(afterUnreg.snapshot.descriptors.find((d) => d.id === 'AGY-W04')?.observe).toBe(
      'upstream_limited',
    );
  });
});

describe('NP-06 Native Command Router: Lanes, Security Negative Cases & Live ACP Dispatch (synthetic T01/T06/T08)', () => {
  it('dispatches live workflows ONCE on the live session preserving slash-first attachment order, and rejects unauthorized/invalid commands', async () => {
    const catalog = new AgyNativeCommandCatalogService();
    const binding = makeSyntheticBinding();
    const { snapshot } = catalog.updateBindingSignals(
      binding,
      makeSyntheticVerifiedSignals({
        advertisedCommands: SYNTHETIC_ACP_COMMANDS_WITH_UNKNOWN,
      }),
    );

    const dispatchedCalls: LiveWorkflowDispatchInput[] = [];
    const configApplies: Array<{ kind: string; value: string | null; enforcement?: string }> = [];
    let auxiliaryProcessSpawned = false;

    const router = new AgyNativeCommandRouter({
      catalog,
      queryUsage: async (b) => ({
        output: `Usage for ${b.instanceId}: 85% remaining`,
        summaryFields: { remainingPercent: 85 },
      }),
      querySkills: async () => ({
        skills: [{ name: 'triage', description: 'Triage issues', enabled: true }],
      }),
      applySessionConfig: async (input) => {
        configApplies.push({ kind: input.kind, value: input.value, enforcement: input.enforcement });
        return {
          applied: true,
          effectiveScope: 'immediate',
          effectiveValue: input.value,
          enforcement: input.enforcement,
        };
      },
      dispatchLiveWorkflow: async (input) => {
        dispatchedCalls.push(input);
        return {
          activityId: asActivityId('act_live_01'),
          turnId: 'turn_live_01',
          modeEvidenceObserved: false,
        };
      },
      readManagerSnapshot: async () => ({
        agentCount: 2,
        activeWorkCount: 1,
        daemonCount: 1,
        swarmBoardAvailable: false,
      }),
    });

    // 1. Live workflow (/swarm) dispatches ONCE to live ACP with ordered attachments & honest modeEvidenceObserved=false
    const swarmRes = await router.executeCommand({
      binding,
      receiptId: 'rcpt_1',
      request: {
        bindingGeneration: binding.generation,
        catalogRevision: snapshot.capabilitiesRevision,
        capabilityId: 'AGY-W04',
        actionKey: 'launch_swarm',
        args: {
          task: 'Review auth module',
          attachmentIds: ['att_first', 'att_second', 'att_third'],
        },
        idempotencyKey: 'idem_swarm_1',
      },
    });
    expect(swarmRes.kind).toBe('accepted');
    if (swarmRes.kind === 'accepted') {
      expect(swarmRes.activityId).toBe('act_live_01');
      expect(swarmRes.modeEvidenceObserved).toBe(false);
    }
    expect(dispatchedCalls).toHaveLength(1);
    expect(dispatchedCalls[0]?.promptText).toBe('/swarm Review auth module');
    expect(dispatchedCalls[0]?.attachmentIds).toEqual(['att_first', 'att_second', 'att_third']);
    expect(auxiliaryProcessSpawned).toBe(false);

    // 2. Negative: unknown dynamic slash command is rejected
    await expect(
      router.executeCommand({
        binding,
        receiptId: 'rcpt_unk',
        request: {
          bindingGeneration: binding.generation,
          catalogRevision: snapshot.capabilitiesRevision,
          capabilityId: 'AGY-DYN-mystery-tui-slash',
          actionKey: 'run_unknown_dynamic',
          args: {},
          idempotencyKey: 'idem_unk_1',
        },
      }),
    ).rejects.toMatchObject({
      name: 'NativeCommandRouterError',
      code: 'UNSUPPORTED_ACTION',
      statusCode: 422,
    } satisfies Partial<NativeCommandRouterError>);

    // 3. Negative: stale catalogRevision -> 409 STALE_BINDING
    await expect(
      router.executeCommand({
        binding,
        receiptId: 'rcpt_stale_rev',
        request: {
          bindingGeneration: binding.generation,
          catalogRevision: 999,
          capabilityId: 'AGY-W09',
          actionKey: 'launch_goal',
          args: { objective: 'Ship NP-06' },
          idempotencyKey: 'idem_stale_rev',
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_BINDING', statusCode: 409 });

    // 4. Negative: stale bindingGeneration -> 409 STALE_BINDING
    await expect(
      router.executeCommand({
        binding,
        receiptId: 'rcpt_stale_gen',
        request: {
          bindingGeneration: asBindingGeneration('gen_old'),
          catalogRevision: snapshot.capabilitiesRevision,
          capabilityId: 'AGY-W09',
          actionKey: 'launch_goal',
          args: { objective: 'Ship NP-06' },
          idempotencyKey: 'idem_stale_gen',
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_BINDING', statusCode: 409 });

    // 5. Negative: Consumer OAuth automated / forged provenance -> 403 CONSUMER_PROVENANCE_BLOCKED
    for (const badProv of [
      { channel: 'human_direct', actor: 'desktop' }, // forged plain object
      mintAgyDispatchProvenance('hm_orchestrator_delegation', 'system'),
      mintAgyDispatchProvenance('auto_failover', 'system'),
      mintAgyDispatchProvenance('plugin_automated', 'plugin'),
    ]) {
      await expect(
        router.executeCommand({
          binding,
          receiptId: 'rcpt_bad_prov',
          provenance: badProv,
          request: {
            bindingGeneration: binding.generation,
            catalogRevision: snapshot.capabilitiesRevision,
            capabilityId: 'AGY-W09',
            actionKey: 'launch_goal',
            args: { objective: 'Unauthorized auto task' },
            idempotencyKey: 'idem_bad_prov',
          },
        }),
      ).rejects.toMatchObject({ code: 'CONSUMER_PROVENANCE_BLOCKED', statusCode: 403 });
    }

    // 6. Negative: Missing required param -> 400 INVALID_REQUEST; unadvertised model/effort -> 422 UNSUPPORTED_ACTION
    await expect(
      router.executeCommand({
        binding,
        receiptId: 'rcpt_missing_arg',
        request: {
          bindingGeneration: binding.generation,
          catalogRevision: snapshot.capabilitiesRevision,
          capabilityId: 'AGY-W09',
          actionKey: 'launch_goal',
          args: {},
          idempotencyKey: 'idem_missing_arg',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', statusCode: 400 });

    await expect(
      router.executeCommand({
        binding,
        receiptId: 'rcpt_bad_model',
        request: {
          bindingGeneration: binding.generation,
          catalogRevision: snapshot.capabilitiesRevision,
          capabilityId: 'AGY-S10',
          actionKey: 'set_model',
          args: { modelId: 'unlisted-low-tier-model' },
          idempotencyKey: 'idem_bad_model',
        },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION', statusCode: 422 });

    await expect(
      router.executeCommand({
        binding,
        receiptId: 'rcpt_bad_effort',
        request: {
          bindingGeneration: binding.generation,
          catalogRevision: snapshot.capabilitiesRevision,
          capabilityId: 'AGY-S12',
          actionKey: 'set_effort',
          args: { effort: 'max' }, // Flash fixture only advertises low/medium/high
          idempotencyKey: 'idem_bad_effort',
        },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION', statusCode: 422 });

    // 7. Config lane: /permissions auto when auto is NOT advertised -> honest client_guard (T06)
    const permRes = await router.executeCommand({
      binding,
      receiptId: 'rcpt_perm',
      request: {
        bindingGeneration: binding.generation,
        catalogRevision: snapshot.capabilitiesRevision,
        capabilityId: 'AGY-S13',
        actionKey: 'set_permission_mode',
        args: { mode: 'auto' },
        idempotencyKey: 'idem_perm_1',
      },
    });
    expect(permRes.kind).toBe('inspect');
    if (permRes.kind === 'inspect') {
      expect(permRes.summaryFields?.enforcement).toBe('client_guard');
    }
    expect(configApplies[0]).toEqual({
      kind: 'permission_mode',
      value: 'auto',
      enforcement: 'client_guard',
    });

    // 8. Query lane (/usage & /skills) and Manager lane (/tasks & /swarm board)
    const revAfterPerm = catalog.getSnapshot(binding).capabilitiesRevision;
    const usageRes = await router.executeCommand({
      binding,
      receiptId: 'rcpt_usage',
      request: {
        bindingGeneration: binding.generation,
        catalogRevision: revAfterPerm,
        capabilityId: 'AGY-S15',
        actionKey: 'query_usage',
        args: {},
        idempotencyKey: 'idem_usage_1',
      },
    });
    expect(usageRes.kind).toBe('inspect');
    if (usageRes.kind === 'inspect') {
      expect(usageRes.output).toContain('85%');
      expect(usageRes.summaryFields?.mutatedConversation).toBe(false);
    }

    const tasksRes = await router.executeCommand({
      binding,
      receiptId: 'rcpt_tasks',
      request: {
        bindingGeneration: binding.generation,
        catalogRevision: revAfterPerm,
        capabilityId: 'AGY-W11',
        actionKey: 'inspect_tasks',
        args: {},
        idempotencyKey: 'idem_tasks_1',
      },
    });
    expect(tasksRes.kind).toBe('inspect');
    if (tasksRes.kind === 'inspect') {
      expect(tasksRes.output).toContain('官方 CLI /tasks');
      expect(tasksRes.summaryFields?.mutatedConversation).toBe(false);
    }
  });

  it('blocks interactive native workflows from entering final-only runAgyCommand auxiliary process', async () => {
    const controller = new AbortController();
    for (const cmd of [
      '/swarm refactor module',
      '/boost optimize query',
      '/teamwork build portal',
      '/run-workflow audit files',
      '/schedule 5m check build',
      '/grill-me api design',
    ]) {
      expect(isInteractiveWorkflowSlashCommand(cmd)).toBe(true);
      await expect(
        runAgyCommand(
          'nonexistent-binary-must-not-spawn',
          { cwd: process.cwd(), permissionMode: 'manual' },
          cmd,
          null,
          controller.signal,
        ),
      ).rejects.toBeInstanceOf(AgyInteractiveWorkflowFallbackError);
    }

    // With blockGoalAuxiliaryFallback enabled, /goal is also prevented from spawning a final-only CLI
    expect(isInteractiveWorkflowSlashCommand('/goal ship feature', { includeGoal: true })).toBe(true);
    await expect(
      runAgyCommand(
        'nonexistent-binary-must-not-spawn',
        { cwd: process.cwd(), permissionMode: 'manual' },
        '/goal ship feature',
        null,
        controller.signal,
        { blockGoalAuxiliaryFallback: true },
      ),
    ).rejects.toBeInstanceOf(AgyInteractiveWorkflowFallbackError);

    // inspectAgyCommand rejects non-read-only commands
    await expect(
      inspectAgyCommand('nonexistent-binary', process.cwd(), '/swarm' as '/usage'),
    ).rejects.toThrow(/仅允许只读独立查询/);
  });
});

describe('NP-06 Multi-Profile /usage & /skills Isolation, Zero Conversation Writes & Legacy Regression (T15)', () => {
  it('isolates /usage and /skills per profile harnessId without writing conversation and refuses silent fallback to default agy', async () => {
    const tmp = makeTempDir('hm-np06-profiles-');
    const callsLog = path.join(tmp, 'cli-calls.jsonl');
    const profilesRoot = path.join(tmp, 'profiles');

    const registry = new HarnessRegistry();
    const adapterA = makeIsolatedAgyAdapter(profilesRoot, 'agy-acct-a', 'placeholder', true);
    const adapterB = makeIsolatedAgyAdapter(profilesRoot, 'agy-acct-b', 'placeholder', true);
    const dirA = adapterA.getLaunchContextSync().geminiDir;
    const dirB = adapterB.getLaunchContextSync().geminiDir;
    const fakeCli = createFakeAgyCliScript(tmp, callsLog, dirB);
    adapterA.getLaunchContextSync(fakeCli);
    adapterB.getLaunchContextSync(fakeCli);
    registry.register(adapterA);
    registry.register(adapterB);

    const tools = new HarnessCommandTools(() => undefined, { agy: fakeCli }, registry);

    const makeSession = (harnessId: string): Session => ({
      id: `sess_${harnessId}`,
      workspaceId: 'ws_1',
      harnessId,
      harnessKind: 'agy',
      nativeSessionId: 'conv_existing_123',
      participatingHarnesses: [harnessId],
      contextSyncMode: 'auto',
      cwd: tmp,
      title: `Session ${harnessId}`,
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      usage: null,
      pendingApprovalCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const skillsA = await tools.listAgySkillsForSession(makeSession('agy-acct-a'));
    const skillsB = await tools.listAgySkillsForSession(makeSession('agy-acct-b'));
    const usageA = await tools.getUsage(makeSession('agy-acct-a'));
    const usageB = await tools.getUsage(makeSession('agy-acct-b'));

    expect(skillsA.map((s) => s.name)).toEqual(['profile-a-skill']);
    expect(skillsB.map((s) => s.name)).toEqual(['profile-b-skill']);
    expect(usageA).toContain('AcctA-Bucket');
    expect(usageB).toContain('AcctB-Bucket');

    // Explicit unknown AGY profile ID MUST NOT silently fall back to default 'agy'
    await expect(tools.listAgySkills(tmp, 'agy-nonexistent-profile')).rejects.toThrow(
      /拒绝回落到默认账号/,
    );

    // Verify every CLI invocation used isolated GEMINI_HOME and NEVER passed --conversation
    const calls = fs
      .readFileSync(callsLog, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { args: string[]; geminiHome: string });
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.args).not.toContain('--conversation');
      expect(call.args).toContain('--output-format');
      expect(call.args).toContain('json');
    }
    expect(path.resolve(calls[0]!.geminiHome).toLowerCase()).toBe(path.resolve(dirA).toLowerCase());
    expect(path.resolve(calls[1]!.geminiHome).toLowerCase()).toBe(path.resolve(dirB).toLowerCase());
    expect(path.resolve(calls[2]!.geminiHome).toLowerCase()).toBe(path.resolve(dirA).toLowerCase());
    expect(path.resolve(calls[3]!.geminiHome).toLowerCase()).toBe(path.resolve(dirB).toLowerCase());

    // Confirm no conversation DB files were created by /usage or /skills
    const convDbDirA = path.join(adapterA.getLaunchContextSync(fakeCli).appDataPath, 'conversations');
    const convDbDirB = path.join(adapterB.getLaunchContextSync(fakeCli).appDataPath, 'conversations');
    expect(fs.existsSync(convDbDirA)).toBe(false);
    expect(fs.existsSync(convDbDirB)).toBe(false);
  });

  it('preserves legacy 8-command enum for Codex, Claude, and AGY (regression check)', () => {
    const expected = ['model', 'plan', 'usage', 'compact', 'goal', 'plugin', 'skills', 'skill'];
    expect(listHarnessCommands('codex', false).map((c) => c.command)).toEqual(expected);
    expect(listHarnessCommands('claude', false).map((c) => c.command)).toEqual(expected);
    expect(listHarnessCommands('agy', false).map((c) => c.command)).toEqual(expected);
    expect(listHarnessCommands('agy', true).map((c) => c.command)).toEqual(['model', 'plan', 'usage']);
  });
});

describe('NP-06 Shared Wiring Integration: Duplicate Idempotency Key, Stop Control & Feature Gate (T08)', () => {
  it('enforces single execution on duplicate idempotencyKey, 409 IDEMPOTENCY_CONFLICT on mutated payload, and feature-off 503', async () => {
    const tmp = makeTempDir('hm-np06-wiring-');
    const daemon = createDaemon({
      dataDir: path.join(tmp, 'data'),
      port: 0,
      webDistDir: null,
    });
    activeDaemons.push(daemon);

    const ws = daemon.store.createWorkspace({
      id: 'ws_np06',
      name: 'NP06 Workspace',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: Date.now(),
    });
    const session = daemon.store.createSession({
      id: 'sess_np06_int',
      workspaceId: ws.id,
      harnessId: 'agy',
      harnessKind: 'agy',
      nativeSessionId: null,
      cwd: tmp,
      worktreeBranch: null,
      title: 'NP-06 Integration',
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const catalog = new AgyNativeCommandCatalogService();
    let liveDispatchCount = 0;
    let cancelDispatchCount = 0;

    const router = new AgyNativeCommandRouter({
      catalog,
      dispatchLiveWorkflow: async () => {
        liveDispatchCount += 1;
        return {
          activityId: asActivityId('act_np06_int_1'),
          turnId: 'turn_np06_int_1',
          modeEvidenceObserved: false,
        };
      },
      dispatchNativeCancel: async () => {
        cancelDispatchCount += 1;
        return {
          accepted: true,
          state: 'requested',
          revision: 1,
        };
      },
    });

    daemon.nativeRegistry.registerModules({ commandRouter: router });

    // 1. Default feature-off returns 503 NATIVE_RUNTIME_DISABLED without affecting session
    const disabledRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: 'gen_0',
        catalogRevision: 0,
        capabilityId: 'AGY-W09',
        actionKey: 'launch_goal',
        args: { objective: 'Test' },
        idempotencyKey: 'idem_off_1',
      },
    });
    expect(disabledRes.statusCode).toBe(503);
    expect(disabledRes.json().code).toBe('NATIVE_RUNTIME_DISABLED');

    // 2. Enable nativeCommands and prime binding signals
    daemon.nativeRegistry.setFeatureFlags({ enabled: true, nativeCommands: true });
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
    const { snapshot } = catalog.updateBindingSignals(
      binding,
      makeSyntheticVerifiedSignals({ advertisedCommands: SYNTHETIC_ACP_COMMANDS_FULL }),
    );

    // 3. First submission -> 202 Accepted
    const first = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: snapshot.capabilitiesRevision,
        capabilityId: 'AGY-W09',
        actionKey: 'launch_goal',
        args: { objective: 'Verify single send' },
        idempotencyKey: 'idem_dup_key_1',
      },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().kind).toBe('accepted');
    expect(first.json().modeEvidenceObserved).toBe(false);
    expect(liveDispatchCount).toBe(1);

    // 4. Duplicate submission with same idempotencyKey & same payload -> replays cached 202, ZERO extra dispatch
    const replay = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: snapshot.capabilitiesRevision,
        capabilityId: 'AGY-W09',
        actionKey: 'launch_goal',
        args: { objective: 'Verify single send' },
        idempotencyKey: 'idem_dup_key_1',
      },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().receiptId).toBe(first.json().receiptId);
    expect(liveDispatchCount).toBe(1);

    // 5. Same idempotencyKey with DIFFERENT payload -> 409 IDEMPOTENCY_CONFLICT
    const conflict = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/commands`,
      payload: {
        bindingGeneration: binding.generation,
        catalogRevision: snapshot.capabilitiesRevision,
        capabilityId: 'AGY-W09',
        actionKey: 'launch_goal',
        args: { objective: 'Different objective' },
        idempotencyKey: 'idem_dup_key_1',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect(liveDispatchCount).toBe(1);

    // 6. Control Stop via router directly distinguishes `requested` from `applied` and rejects unverified child cancel
    const stopRes = await router.executeControl({
      binding,
      receiptId: 'rcpt_stop_1',
      request: {
        generation: binding.generation,
        target: { type: 'runtime', id: binding.runtimeId },
        action: 'cancel',
        expectedRevision: 0,
        idempotencyKey: 'ctrl_stop_1',
      },
    });
    expect(stopRes.schemaVersion).toBe(AGY_NATIVE_CONTRACT_VERSION);
    expect(stopRes.accepted).toBe(true);
    expect(stopRes.state).toBe('requested');
    expect(cancelDispatchCount).toBe(1);

    await expect(
      router.executeControl({
        binding,
        receiptId: 'rcpt_child_stop',
        request: {
          generation: binding.generation,
          target: { type: 'agent', id: asRuntimeId('agt_unverified_1') },
          action: 'cancel',
          expectedRevision: 0,
          idempotencyKey: 'ctrl_child_stop',
        },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION', statusCode: 422 });
  });
});
