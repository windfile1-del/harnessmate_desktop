import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HARNESS_DRIVER_CODEX_CONTRACT,
  PEER_CONTRACTS,
  type DriverCommandReceipt,
  type SessionHandoffServiceV1,
  type SessionOrchestrationServiceV1,
} from '@harnessmate/plugin-api';
import {
  createDeterministicMockDriverFixture,
  replayAdapterTranscript,
  type DeterministicMockDriverController,
} from '@harnessmate/plugin-sdk/testing';
import type { HarnessInfo, Session } from '@harnessmate/protocol';
import {
  saveConfig,
  loadOrCreateConfig,
} from '../src/config.js';
import { AcpAdapter } from '../src/harnesses/acp-adapter.js';
import { evaluateAgyConsumerProvenance, mintAgyDispatchProvenance } from '../src/harnesses/agy/native/wiring/provenance.js';
import { ClaudeStreamJsonAdapter } from '../src/harnesses/claude-adapter.js';
import { CodexAppServerAdapter } from '../src/harnesses/codex-adapter.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NormalizedAdapterEvent,
  TurnInput,
} from '../src/harnesses/types.js';
import { auditPluginPackage } from '../src/plugins/plugin-static-audit.js';
import { HARNESS_CODEX_PLUGIN_ID } from '../src/plugins/harness-codex-default/index.js';
import { HARNESS_CLAUDE_PLUGIN_ID } from '../src/plugins/harness-claude-default/index.js';
import { HARNESS_ACP_PLUGIN_ID } from '../src/plugins/harness-acp-default/index.js';
import { CONTEXT_COMPRESSION_PLUGIN_ID } from '../src/plugins/context-compression-default/index.js';
import { SESSION_HANDOFF_DEFAULT_PLUGIN_ID } from '../src/plugins/session-handoff-default/index.js';
import { SESSION_COLLABORATION_DEFAULT_PLUGIN_ID } from '../src/plugins/session-collaboration-default/index.js';
import { ORCHESTRATOR_PLUGIN_ID } from '../src/plugins/orchestrator-default/index.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const codexLiteDir = path.join(repoRoot, 'plugins', 'examples', 'hm.plugin.codex-driver-lite');
const TEST_TMP_ROOT = process.env.HARNESSMATE_TEST_TMP || 'D:/HarnessMate/b3-tmp/w2';

const tempDirs: string[] = [];
const activeDaemons: DaemonInstance[] = [];

function makeTempDir(prefix: string): string {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, prefix));
  tempDirs.push(dir);
  return dir;
}

function readPluginFilesForAudit(dirPath: string): { manifest: Record<string, unknown>; files: Record<string, string> } {
  const manifest = JSON.parse(fs.readFileSync(path.join(dirPath, 'harnessmate-plugin.json'), 'utf8')) as Record<string, unknown>;
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, entry);
    if (fs.statSync(full).isFile()) {
      files[entry] = fs.readFileSync(full, 'utf8');
    }
  }
  return { manifest, files };
}

function wrapMockDriver(
  id: string,
  driverId: 'codex' | 'claude' | 'acp',
  ctrl: DeterministicMockDriverController,
  supportedCommands?: HarnessAdapter['supportedCommands'],
): HarnessAdapter {
  const info: HarnessInfo = {
    id,
    kind: driverId,
    driverId,
    continuationKey: `${driverId}:mock:${id}`,
    displayName: ctrl.driver.displayName,
    description: ctrl.driver.description,
    protocolLabel: ctrl.driver.protocolLabel,
    binaryPath: null,
    version: '1.0.0-mock',
    health: 'ready',
    capabilities: ctrl.driver.capabilities,
    capabilitiesV2: ctrl.driver.capabilitiesV2,
    supportedCommands,
    models: [{ id: `${driverId}-mock-model`, displayName: `${driverId} Mock`, isDefault: true }],
    defaultModelId: `${driverId}-mock-model`,
  };
  return {
    id,
    kind: driverId,
    driverId,
    continuationKey: info.continuationKey,
    displayName: info.displayName,
    description: info.description,
    protocolLabel: info.protocolLabel,
    capabilities: info.capabilities,
    capabilitiesV2: info.capabilitiesV2,
    supportedCommands,
    probePassive: async () => info,
    probe: async () => info,
    async createSession(config: AdapterSessionConfig): Promise<AdapterSessionHandle> {
      const inner = await ctrl.driver.createSession({
        cwd: config.cwd,
        model: config.model ?? null,
        reasoningEffort: config.reasoningEffort ?? null,
        permissionMode: config.permissionMode,
        nativeSessionId: config.nativeSessionId ?? null,
      });
      return {
        get nativeSessionId() {
          return inner.nativeSessionId ?? null;
        },
        sendTurn: (input: TurnInput) => inner.sendTurn(input as never),
        interrupt: () => inner.interrupt(),
        resolveApproval: (nativeRequestId, decision, comment) =>
          inner.resolveApproval(nativeRequestId, decision, comment),
        updateConfig: (patch) => inner.updateConfig(patch as never),
        dispose: () => inner.dispose(),
        onEvent: (listener: (ev: NormalizedAdapterEvent) => void) =>
          inner.onEvent(listener as never),
      };
    },
  };
}

async function installAndGrantPluginHttp(daemon: DaemonInstance, dirPath: string) {
  const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath });
  const installed = await daemon.pluginManager.installPlugin({
    mode: 'local_dir',
    dirPath,
    trustCode: true,
    expectedDigest: preview.digest,
    expectedInstalledDigest: preview.installedDigest,
  });
  for (const capability of preview.manifest.permissions ?? []) {
    const res = await daemon.app.inject({
      method: 'PUT',
      url: `/api/v1/plugins/${preview.manifest.id}/permissions`,
      payload: {
        workspaceId: '__global__',
        digest: preview.digest,
        capability,
        granted: true,
      },
    });
    expect(res.statusCode).toBe(200);
  }
  return { preview, installed };
}

async function waitFor<T>(fn: () => Promise<T> | T, predicate: (v: T) => boolean, timeoutMs = 6000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (predicate(val)) return val;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

function initGitRepoWithFile(repoPath: string, filename = 'README.md', content = '# Test Repo\n'): void {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@harnessmate.local'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'HarnessMate Test'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, filename), content, 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const d = activeDaemons.pop()!;
    await d.stop().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Ignore transient Windows file-lock EPERM on test temp cleanup
    }
  }
});

describe('Batch 3 · W2 Universal Drivers & Session Collaboration', () => {
  it('audits pure-SDK codex-driver-lite, completes real install -> configure -> bind -> revoke -> restore, and enforces AGY reserve', async () => {
    const pkgFiles = readPluginFilesForAudit(codexLiteDir);
    const audited = auditPluginPackage(pkgFiles.files, pkgFiles.manifest);
    expect(audited.passed).toBe(true);
    expect(audited.blockingIssues).toEqual([]);

    const dataDir = makeTempDir('w2-lifecycle-data-');
    const wsRoot = makeTempDir('w2-lifecycle-ws-');
    const daemon = createDaemon({ dataDir, port: 0 });
    activeDaemons.push(daemon);
    await daemon.start();

    const { preview } = await installAndGrantPluginHttp(daemon, codexLiteDir);
    const servicesRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/plugins/services?contract=${HARNESS_DRIVER_CODEX_CONTRACT}`,
    });
    expect(servicesRes.statusCode).toBe(200);
    const providers = (servicesRes.json() as { providers: Array<{ pluginId: string; instanceId: string }> }).providers;
    expect(providers.some((p) => p.instanceId === 'harness-codex')).toBe(true);
    expect(providers.some((p) => p.pluginId === 'hm.plugin.codex-driver-lite')).toBe(true);

    // Update external plugin config (codexHome + binaryPath + supportsCompact=false) via composition instance
    const cfgRes = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/composition/instances',
      payload: {
        id: 'hm.plugin.codex-driver-lite',
        config: {
          label: 'Codex Lite Work',
          codexHome: '/virtual-home/work-profile',
          binaryPath: '/virtual-bin/work-codex',
          supportsCompact: false,
        },
      },
    });
    expect(cfgRes.statusCode).toBe(200);

    const harnessesAfterInstall = (
      await daemon.app.inject({ method: 'GET', url: '/api/v1/harnesses?refresh=1' })
    ).json() as { harnesses: HarnessInfo[] };
    const extCodex = harnessesAfterInstall.harnesses.find((h) => h.providerPluginId === 'hm.plugin.codex-driver-lite');
    expect(extCodex).toBeDefined();
    expect(extCodex?.driverId).toBe('codex');
    expect(extCodex?.binaryPath).toBe('/virtual-bin/work-codex');
    expect(extCodex?.displayName).toBe('Codex Lite Work');

    // Workspace binding -> revoke -> restore
    const ws = (
      await daemon.app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        payload: { name: 'WS-Bind', rootPath: wsRoot },
      })
    ).json() as { workspace: { id: string } };

    const bindRes = await daemon.app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${ws.workspace.id}/bindings`,
      payload: { contract: HARNESS_DRIVER_CODEX_CONTRACT, instanceId: 'hm.plugin.codex-driver-lite' },
    });
    expect(bindRes.statusCode).toBe(200);

    // Revoke permission -> external driver unregisters
    const revokeRes = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/hm.plugin.codex-driver-lite/permissions',
      payload: {
        workspaceId: '__global__',
        digest: preview.digest,
        capability: 'harness:driver:register',
        granted: false,
      },
    });
    expect(revokeRes.statusCode).toBe(200);
    const harnessesAfterRevoke = (
      await daemon.app.inject({ method: 'GET', url: '/api/v1/harnesses' })
    ).json() as { harnesses: HarnessInfo[] };
    expect(harnessesAfterRevoke.harnesses.some((h) => h.providerPluginId === 'hm.plugin.codex-driver-lite')).toBe(false);

    // Restore permission -> external driver returns without error
    const restoreRes = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/hm.plugin.codex-driver-lite/permissions',
      payload: {
        workspaceId: '__global__',
        digest: preview.digest,
        capability: 'harness:driver:register',
        granted: true,
      },
    });
    expect(restoreRes.statusCode).toBe(200);
    const harnessesAfterRestore = (
      await daemon.app.inject({ method: 'GET', url: '/api/v1/harnesses' })
    ).json() as { harnesses: HarnessInfo[] };
    expect(harnessesAfterRestore.harnesses.some((h) => h.providerPluginId === 'hm.plugin.codex-driver-lite')).toBe(true);
  }, 45_000);

  it('isolates two workspaces on different Codex providers independently of load order and pins in-flight handles across rebinds', async () => {
    const dataDir = makeTempDir('w2-iso-data-');
    const wsADir = makeTempDir('w2-iso-wsa-');
    const wsBDir = makeTempDir('w2-iso-wsb-');

    const defaultCodexCtrl = createDeterministicMockDriverFixture({
      driverId: 'codex',
      displayName: 'Default Mock Codex',
      defaultScript: { chunks: ['from default ', 'codex driver'] },
    });
    const daemon = createDaemon({
      dataDir,
      port: 0,
      customAdapters: [wrapMockDriver('codex', 'codex', defaultCodexCtrl)],
    });
    activeDaemons.push(daemon);
    await daemon.start();
    await installAndGrantPluginHttp(daemon, codexLiteDir);

    const wsA = (await daemon.app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'WS-A', rootPath: wsADir } }))
      .json() as { workspace: { id: string } };
    const wsB = (await daemon.app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'WS-B', rootPath: wsBDir } }))
      .json() as { workspace: { id: string } };

    // Bind WS-A to harness-codex (default), WS-B to hm.plugin.codex-driver-lite
    await daemon.app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${wsA.workspace.id}/bindings`,
      payload: { contract: HARNESS_DRIVER_CODEX_CONTRACT, instanceId: 'harness-codex' },
    });
    await daemon.app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${wsB.workspace.id}/bindings`,
      payload: { contract: HARNESS_DRIVER_CODEX_CONTRACT, instanceId: 'hm.plugin.codex-driver-lite' },
    });

    const sessARes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { workspaceId: wsA.workspace.id, harnessId: 'codex', title: 'Session A' },
    });
    const sessBRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { workspaceId: wsB.workspace.id, harnessId: 'codex', title: 'Session B' },
    });
    expect(sessARes.statusCode).toBe(201);
    expect(sessBRes.statusCode).toBe(201);
    const sessA = (sessARes.json() as { session: Session }).session;
    const sessB = (sessBRes.json() as { session: Session }).session;
    expect(sessA.harnessId).toBe('codex');
    expect(sessA.driverProviderInstanceId).toBe('harness-codex');
    expect(sessB.harnessId).toBe('hm.plugin.codex-driver-lite:codex');
    expect(sessB.driverProviderInstanceId).toBe('hm.plugin.codex-driver-lite');

    // Run turn on Session B (external codex lite): streaming, resume, commands, config receipt
    await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessB.id}/turns`,
      payload: { text: 'hello external codex' },
    });
    await waitFor(
      async () => ((await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessB.id}` })).json() as { session: Session }).session,
      (s) => s.status === 'idle' && Boolean(s.nativeSessionId),
    );
    const updatedB = await daemon.sessionManager.getSessionAsync(sessB.id);
    expect(updatedB?.nativeSessionId).toContain('thr_lite_');

    // Supported vs unsupported native command receipts on external Codex
    const goalCmdRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessB.id}/commands`,
      payload: { harnessId: sessB.harnessId, command: 'goal', args: 'ship W2 clean' },
    });
    expect(goalCmdRes.statusCode).toBe(200);
    const goalPayload = goalCmdRes.json() as { output: string; receipt?: DriverCommandReceipt };
    expect(goalPayload.receipt?.status).toBe('executed');
    expect(goalPayload.output).toContain('ship W2 clean');

    // Disable compact via config and verify honest unsupported receipt (never fakes success)
    await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/composition/instances',
      payload: { id: 'hm.plugin.codex-driver-lite', config: { supportsCompact: false } },
    });
    const compactRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessB.id}/commands`,
      payload: { harnessId: sessB.harnessId, command: 'compact', args: '' },
    });
    expect(compactRes.statusCode).toBe(200);
    expect((compactRes.json() as { receipt?: DriverCommandReceipt }).receipt?.status).toBe('unsupported');

    // In-flight handle pinning: start a manual turn on Session A (harness-codex), then rebind WS-A to hm.plugin.codex-driver-lite mid-turn
    defaultCodexCtrl.setNextTurnScript({ manualControl: true });
    await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessA.id}/turns`,
      payload: { text: 'mid-flight rebind check' },
    });
    await waitFor(
      () => defaultCodexCtrl.dispatchedTurns.length,
      (len) => len >= 1,
    );
    const inFlightTurnId = defaultCodexCtrl.dispatchedTurns[0]!.turnId;

    await daemon.app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${wsA.workspace.id}/bindings`,
      payload: { contract: HARNESS_DRIVER_CODEX_CONTRACT, instanceId: 'hm.plugin.codex-driver-lite' },
    });

    // Complete in-flight turn on original harness-codex handle
    defaultCodexCtrl.completeTurn(inFlightTurnId, 'completed on pinned generation');
    await waitFor(
      async () => ((await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessA.id}` })).json() as { session: Session }).session,
      (s) => s.status === 'idle',
    );
    const sessAAfterRebind = await daemon.sessionManager.getSessionAsync(sessA.id);
    expect(sessAAfterRebind?.harnessId).toBe('codex');

    // New session in WS-A uses updated binding, while existing Session A stays pinned to harness-codex across daemon restart
    const sessA2Res = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { workspaceId: wsA.workspace.id, harnessId: 'codex', title: 'Session A2 Post-Rebind' },
    });
    const sessA2 = (sessA2Res.json() as { session: Session }).session;
    expect(sessA2.harnessId).toBe('hm.plugin.codex-driver-lite:codex');

    await daemon.stop();
    activeDaemons.pop();

    // Restart with reversed binding/load scenario on same dataDir
    const daemonRestarted = createDaemon({ dataDir, port: 0 });
    activeDaemons.push(daemonRestarted);
    await daemonRestarted.start();

    const sessAPinnedAfterRestart = await daemonRestarted.sessionManager.getSessionAsync(sessA.id);
    const sessBPinnedAfterRestart = await daemonRestarted.sessionManager.getSessionAsync(sessB.id);
    expect(sessAPinnedAfterRestart?.harnessId).toBe('codex');
    expect(sessBPinnedAfterRestart?.harnessId).toBe('hm.plugin.codex-driver-lite:codex');
    const resolvedB = (
      await daemonRestarted.app.inject({
        method: 'GET',
        url: `/api/v1/plugins/services/resolve?contract=${HARNESS_DRIVER_CODEX_CONTRACT}&workspaceId=${wsB.workspace.id}`,
      })
    ).json() as { instanceId: string };
    expect(resolvedB.instanceId).toBe('hm.plugin.codex-driver-lite');
  }, 45_000);

  it('supports same-package multi-instance Codex/Claude config, ACP custom harnesses & honest receipts, and protocol replay', async () => {
    const dataDir = makeTempDir('w2-multi-inst-');
    const cfgPath = path.join(dataDir, 'config.json');
    const initialCfg = loadOrCreateConfig(cfgPath, 0);
    initialCfg.harnessInstances = [
      {
        instanceId: 'codex.work',
        driverId: 'codex',
        displayName: 'Codex Work',
        binaryPath: '/virtual/work/codex',
        homeDir: '/virtual/home/codex-work',
        envWhitelist: { WORK_PROFILE: 'work', HARNESSMATE_LOCAL_TOKEN: 'secret-should-strip' },
        enabled: true,
      },
      {
        instanceId: 'claude.work',
        driverId: 'claude',
        displayName: 'Claude Work',
        binaryPath: '/virtual/work/claude',
        homeDir: '/virtual/home/claude-work',
        apiBaseUrl: 'https://claude-work.example.internal',
        envWhitelist: { ANTHROPIC_TAG: 'team-a' },
        enabled: true,
      },
    ];
    saveConfig(cfgPath, initialCfg);

    const daemon = createDaemon({ dataDir, port: 0 });
    activeDaemons.push(daemon);
    await daemon.start();

    const entries = daemon.registry.listEntries();
    const codexWork = entries.find((e) => e.harnessId === 'codex.work');
    const claudeWork = entries.find((e) => e.harnessId === 'claude.work');
    expect(codexWork?.pluginId).toBe(HARNESS_CODEX_PLUGIN_ID);
    expect(codexWork?.instanceConfig?.homeDir).toBe('/virtual/home/codex-work');
    expect(codexWork?.instanceConfig?.sanitizedEnv?.WORK_PROFILE).toBe('work');
    expect(codexWork?.instanceConfig?.sanitizedEnv?.HARNESSMATE_LOCAL_TOKEN).toBeUndefined();
    expect(claudeWork?.pluginId).toBe(HARNESS_CLAUDE_PLUGIN_ID);
    expect(claudeWork?.instanceConfig?.homeDir).toBe('/virtual/home/claude-work');

    // Custom ACP harness registration & honest unsupported commands
    const customAcpRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/harnesses/custom',
      payload: {
        id: 'acp-review',
        displayName: 'ACP Reviewer',
        description: 'Generic ACP test engine',
        command: 'echo',
        args: ['--acp'],
      },
    });
    expect(customAcpRes.statusCode).toBe(200);
    const acpEntry = daemon.registry.getEntry('acp-review');
    expect(acpEntry?.pluginId).toBe(HARNESS_ACP_PLUGIN_ID);

    const wsRoot = makeTempDir('w2-acp-ws-');
    const ws = (await daemon.app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'ACP-WS', rootPath: wsRoot } }))
      .json() as { workspace: { id: string } };
    const acpSess = (
      await daemon.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { workspaceId: ws.workspace.id, harnessId: 'acp-review', title: 'ACP Session' },
      })
    ).json() as { session: Session };
    const acpCommands = daemon.sessionManager.getHarnessCommands(acpSess.session);
    expect(acpCommands.find((c) => c.command === 'compact')?.supported).toBe(false);
    const acpCompactRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${acpSess.session.id}/commands`,
      payload: { harnessId: 'acp-review', command: 'compact', args: '' },
    });
    expect(acpCompactRes.statusCode).toBe(200);
    expect((acpCompactRes.json() as { receipt?: DriverCommandReceipt }).receipt?.status).toBe('unsupported');

    // Disabling core.harness.acp enforces 409 E_PLUGIN_DISABLED on /api/v1/harnesses/custom
    await daemon.pluginManager.togglePlugin(HARNESS_ACP_PLUGIN_ID, false);
    const acpDisabledRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/harnesses/custom',
      payload: { id: 'acp-blocked', displayName: 'Blocked', description: 'Blocked', command: 'echo', args: [] },
    });
    expect(acpDisabledRes.statusCode).toBe(409);
    expect((acpDisabledRes.json() as { code: string }).code).toBe('E_PLUGIN_DISABLED');

    // Protocol Replay: Codex / Claude / ACP adapters + SDK driver replayAdapterTranscript
    expect(new CodexAppServerAdapter().capabilitiesV2?.historyInjectionMode).toBe('native_items');
    expect(new ClaudeStreamJsonAdapter().capabilitiesV2?.historyInjectionMode).toBe('sysfile_delta');
    expect(new AcpAdapter({ id: 'acp-probe', displayName: 'ACP', description: 'ACP', command: 'echo', args: [] }).capabilitiesV2?.historyInjectionMode).toBe('embedded_context');

    const replay = await replayAdapterTranscript(
      (line, turnId) => {
        const frame = JSON.parse(line) as { kind: string; text?: string };
        if (frame.kind === 'delta') return { type: 'message.assistant.delta', turnId, text: frame.text ?? '' };
        if (frame.kind === 'done') return { type: 'turn.completed', turnId, stopReason: 'end_turn' };
        return null;
      },
      [
        JSON.stringify({ kind: 'delta', text: 'protocol ' }),
        JSON.stringify({ kind: 'delta', text: 'ok' }),
        JSON.stringify({ kind: 'done' }),
      ],
    );
    expect(replay.terminalEvent?.type).toBe('turn.completed');
    expect(replay.assistantText).toBe('protocol ok');
  }, 35_000);

  it('decouples handoff (with uncertain delivery), compression, collaboration, orchestrator (with Git preservation), and keeps AGY native intact', async () => {
    const dataDir = makeTempDir('w2-collab-data-');
    const repoDir = makeTempDir('w2-collab-repo-');
    initGitRepoWithFile(repoDir, 'app.ts', 'export const v = 1;\n');

    const codexCtrl = createDeterministicMockDriverFixture({
      driverId: 'codex',
      displayName: 'Mock Codex Collab',
      defaultScript: { chunks: ['collab ', 'reply'] },
    });
    const claudeCtrl = createDeterministicMockDriverFixture({
      driverId: 'claude',
      displayName: 'Mock Claude Collab',
      defaultScript: { chunks: ['claude ', 'subagent'] },
    });

    const daemon = createDaemon({
      dataDir,
      port: 0,
      customAdapters: [
        wrapMockDriver('codex', 'codex', codexCtrl),
        wrapMockDriver('claude', 'claude', claudeCtrl),
      ],
    });
    activeDaemons.push(daemon);
    await daemon.start();

    const ws = (await daemon.app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'Collab-Repo', rootPath: repoDir } }))
      .json() as { workspace: { id: string } };
    const sess = (
      await daemon.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { workspaceId: ws.workspace.id, harnessId: 'codex', title: 'Collab Main' },
      })
    ).json() as { session: Session };

    // 1. Handoff uncertain delivery semantics & disablement
    const handoffPeer = daemon.pluginManager.host.getServiceByInstance<SessionHandoffServiceV1>(
      'handoff',
      PEER_CONTRACTS.sessionHandoff,
    )!;
    const pendingRes = await handoffPeer.stagePending({
      sessionId: sess.session.id,
      targetHarnessId: 'claude',
      turnId: 't_uncertain_1',
      driver: 'claude_sysfile',
      coveredUpToSeq: 0,
      estimatedChars: 420,
      redactedCount: 0,
      isWarmBinding: false,
      snapshot: { snapshotId: 'snap_1', sectionHashes: {}, workspaceDigest: 'wd', mutatedFiles: [], omittedItemIds: [] },
    });
    expect(pendingRes.ok).toBe(true);
    const handoffId = pendingRes.ok ? pendingRes.value.handoffId : '';

    const failRes = await handoffPeer.failDelivery({
      handoffId,
      sessionId: sess.session.id,
      targetHarnessId: 'claude',
      resetBinding: true,
      uncertain: true,
    });
    expect(failRes.ok && failRes.value.deliveryStatus).toBe('uncertain');

    // Compile after uncertain delivery must force fresh native session and NOT auto-retry
    const compiledAfterUncertain = await handoffPeer.compile({
      sessionId: sess.session.id,
      targetHarnessId: 'claude',
      targetHarnessKind: 'claude',
      binding: null,
    });
    expect(compiledAfterUncertain.ok).toBe(true);
    if (compiledAfterUncertain.ok) {
      expect(compiledAfterUncertain.value.packet.forceFreshNativeSession).toBe(true);
      expect(compiledAfterUncertain.value.packet.forceFreshReason).toBe('uncertain_previous_delivery');
    }

    // Disabling core.context-bridge -> 409 E_PLUGIN_DISABLED on preview/handoff, basic chat works!
    await daemon.pluginManager.togglePlugin(SESSION_HANDOFF_DEFAULT_PLUGIN_ID, false);
    const previewDisabled = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sess.session.id}/context-preview?targetHarnessId=claude`,
    });
    expect(previewDisabled.statusCode).toBe(409);
    expect((previewDisabled.json() as { code: string }).code).toBe('E_PLUGIN_DISABLED');

    const chatWithHandoffOff = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess.session.id}/turns`,
      payload: { text: 'basic chat while handoff disabled' },
    });
    expect(chatWithHandoffOff.statusCode).toBe(202);
    await waitFor(
      async () => ((await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sess.session.id}` })).json() as { session: Session }).session,
      (s) => s.status === 'idle',
    );
    await daemon.pluginManager.togglePlugin(SESSION_HANDOFF_DEFAULT_PLUGIN_ID, true);

    // 2. Compression disabled -> 409 E_PLUGIN_DISABLED (no fallbackCompressor)
    expect(daemon.pluginManager.host.get('compressor')).toBeUndefined();
    const compCfgDisabled = await daemon.app.inject({ method: 'GET', url: '/api/v1/compression/config' });
    expect(compCfgDisabled.statusCode).toBe(409);
    expect((compCfgDisabled.json() as { code: string }).code).toBe('E_PLUGIN_DISABLED');

    // 3. Collaboration plugin (fork, side-chat, merge-back, export, and 409 when disabled)
    const sideRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess.session.id}/side-chat`,
      payload: { text: 'quick side question' },
    });
    expect(sideRes.statusCode).toBe(200);

    const forkRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess.session.id}/fork`,
      payload: { title: 'Forked Branch', targetHarnessId: 'codex' },
    });
    expect(forkRes.statusCode).toBe(201);
    const forkedSession = (forkRes.json() as { session: Session }).session;

    const mergeBackRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${forkedSession.id}/merge-back`,
      payload: { summaryOverride: 'Merged verified insight' },
    });
    expect(mergeBackRes.statusCode).toBe(200);

    const exportRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sess.session.id}/export?format=json_bundle`,
    });
    expect(exportRes.statusCode).toBe(200);

    await daemon.pluginManager.togglePlugin(SESSION_COLLABORATION_DEFAULT_PLUGIN_ID, false);
    expect(daemon.pluginManager.host.get('session-search')).toBeUndefined();
    const forkDisabledRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess.session.id}/fork`,
      payload: { title: 'Blocked Fork' },
    });
    expect(forkDisabledRes.statusCode).toBe(409);
    expect((forkDisabledRes.json() as { code: string }).code).toBe('E_PLUGIN_DISABLED');
    await daemon.pluginManager.togglePlugin(SESSION_COLLABORATION_DEFAULT_PLUGIN_ID, true);

    // 4. Orchestrator plugin: plugin-owned policy config, subagent cancel/disable settlement + worktree preservation
    expect(daemon.pluginManager.host.get('orchestrator')).toBeUndefined();
    const subagentsDisabledRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sess.session.id}/subagents`,
    });
    expect(subagentsDisabledRes.statusCode).toBe(409);
    expect((subagentsDisabledRes.json() as { code: string }).code).toBe('E_PLUGIN_DISABLED');

    await daemon.pluginManager.togglePlugin(ORCHESTRATOR_PLUGIN_ID, true);
    const orchPeer = daemon.pluginManager.host.getServiceByInstance<SessionOrchestrationServiceV1>(
      ORCHESTRATOR_PLUGIN_ID,
      PEER_CONTRACTS.sessionOrchestration,
    )!;
    const defaultLimits = await orchPeer.getLimits();
    expect(defaultLimits.ok && defaultLimits.value.worktreePolicy).toBe('required_for_write');

    // Delegate active subagent on Git worktree with manual hold so we test plugin-disable settlement
    claudeCtrl.setNextTurnScript({ manualControl: true });
    const delegateRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess.session.id}/subagents`,
      payload: {
        targetInstanceId: 'claude',
        roleTitle: 'Worker-Worktree',
        prompt: 'Implement worker patch cleanly',
        isolation: 'worktree_write',
      },
    });
    expect(delegateRes.statusCode).toBe(201);
    const subagent = (delegateRes.json() as { subagent: { subagentId: string; worktreePath: string; branchName: string } }).subagent;
    expect(fs.existsSync(subagent.worktreePath)).toBe(true);

    // Disable orchestrator while child is running -> settles run to stopped, preserves worktree, no host fallback
    await daemon.pluginManager.togglePlugin(ORCHESTRATOR_PLUGIN_ID, false);
    expect(daemon.pluginManager.host.get('orchestrator')).toBeUndefined();
    const settledRecord = daemon.store.getSubagentRun(subagent.subagentId);
    expect(settledRecord?.status).toBe('stopped');
    expect(fs.existsSync(subagent.worktreePath)).toBe(true);

    const branchCheck = execFileSync('git', ['branch', '--list', subagent.branchName], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    expect(branchCheck).toContain(subagent.branchName);

    // 5. AGY native regression (updated for Batch 4 B4-W1): AGY is now a peer driver with no reserved category,
    // while service contracts (`harness.driver.agy.v1`, `agy.runtime.v1`, `agy.accounts.v1`) and consumer provenance remain intact.
    const agyServiceProviders = daemon.pluginManager.listServiceProviders('harness.driver.agy.v1');
    expect(agyServiceProviders.some((p) => p.pluginId === 'core.harness.agy')).toBe(true);
    expect(daemon.registry.isReserved('agy')).toBe(false);
    expect(daemon.registry.isReserved('codex')).toBe(false);
    const agyGuard = evaluateAgyConsumerProvenance(
      { instanceId: 'agy', driverId: 'agy', profile: null },
      mintAgyDispatchProvenance('hm_orchestrator_delegation', 'system', 'orchestrator.delegate'),
    );
    expect(agyGuard.allowed).toBe(false);
  }, 60_000);
});
