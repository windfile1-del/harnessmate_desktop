import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import {
  PEER_CONTRACTS,
  PEER_CONTRACT_VERSIONS,
  type HistoryImportServiceV1,
  type HistorySourceServiceV1,
  type ServiceResolutionV1,
  type SessionSearchServiceV1,
} from '@harnessmate/plugin-api';
import { registerServiceResolutionRoute } from '../src/plugin-host/composition/resolve-route.js';
import { buildIsolatedChildEnv } from '../src/plugin-host/isolation/isolated-process.js';
import { PluginComposition } from '../src/plugin-host/composition/profile.js';
import { resolveCapabilityBinding } from '../src/plugin-host/composition/bindings.js';
import { PluginHost } from '../src/plugin-host/runtime/lifecycle.js';
import { createDaemon } from '../src/server/app.js';

const cleanupDirs: string[] = [];
const daemons: Array<ReturnType<typeof createDaemon>> = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function safeRmSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best-effort cleanup on Windows transient handles
  }
}

function writePluginPackage(
  parent: string,
  folderName: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): string {
  const dir = path.join(parent, folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'harnessmate-plugin.json'),
    JSON.stringify({ description: 'B1-01 test plugin', author: 'Test', ...manifest }, null, 2),
  );
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

async function createTestDaemon(dataDir: string) {
  const daemon = createDaemon({ dataDir, port: 0, hostOverride: '127.0.0.1' });
  daemons.push(daemon);
  await daemon.start();
  return daemon;
}

async function installTrustedDir(daemon: ReturnType<typeof createDaemon>, dirPath: string) {
  const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath });
  await daemon.pluginManager.installPlugin({
    mode: 'local_dir',
    dirPath,
    trustCode: true,
    expectedDigest: preview.digest,
    expectedInstalledDigest: preview.installedDigest,
  });
  return preview;
}

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.stop().catch(() => {});
  }
  while (cleanupDirs.length > 0) {
    safeRmSync(cleanupDirs.pop()!);
  }
});

it('validates B1-01 peer contract fixtures and exports', async () => {
  const fixturePath = path.resolve(
    process.cwd(),
    '..',
    '..',
    'docs',
    'plugin-decoupling-batch-1',
    'fixtures',
    'B1-01-peer-contracts.json',
  );
  const resolvedPath = fs.existsSync(fixturePath)
    ? fixturePath
    : path.resolve(process.cwd(), 'docs', 'plugin-decoupling-batch-1', 'fixtures', 'B1-01-peer-contracts.json');
  const fixture = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as {
    source: {
      contract: string;
      version: string;
      discover: { request: Parameters<HistorySourceServiceV1['discover']>[0]; response: Awaited<ReturnType<HistorySourceServiceV1['discover']>> };
      read: {
        request: Parameters<HistorySourceServiceV1['read']>[0];
        response: Awaited<ReturnType<HistorySourceServiceV1['read']>>;
        unreadable: Awaited<ReturnType<HistorySourceServiceV1['read']>>;
      };
    };
    import: {
      contract: string;
      version: string;
      preview: { request: Parameters<HistoryImportServiceV1['preview']>[0]; response: Awaited<ReturnType<HistoryImportServiceV1['preview']>> };
      import: {
        request: Parameters<HistoryImportServiceV1['import']>[0];
        response: Awaited<ReturnType<HistoryImportServiceV1['import']>>;
        retry: Awaited<ReturnType<HistoryImportServiceV1['import']>>;
        cancelled: Awaited<ReturnType<HistoryImportServiceV1['import']>>;
      };
    };
    search: {
      contract: string;
      version: string;
      query: { request: Parameters<SessionSearchServiceV1['query']>[0]; response: Awaited<ReturnType<SessionSearchServiceV1['query']>> };
      reindex: { request: Parameters<SessionSearchServiceV1['reindex']>[0]; response: Awaited<ReturnType<SessionSearchServiceV1['reindex']>> };
    };
    resolution: Record<string, ServiceResolutionV1>;
  };

  expect(PEER_CONTRACTS.historySource).toBe(fixture.source.contract);
  expect(PEER_CONTRACTS.historyImport).toBe(fixture.import.contract);
  expect(PEER_CONTRACTS.sessionSearch).toBe(fixture.search.contract);
  expect(PEER_CONTRACT_VERSIONS['history.source.v1']).toBe(fixture.source.version);
  expect(PEER_CONTRACT_VERSIONS['history.import.v1']).toBe(fixture.import.version);
  expect(PEER_CONTRACT_VERSIONS['session.search.v1']).toBe(fixture.search.version);
  expect(fixture.source.discover.response.ok).toBe(true);
  expect(fixture.import.import.retry.ok).toBe(true);
  expect(fixture.search.query.response.ok).toBe(true);
  expect(Object.keys(fixture.resolution)).toHaveLength(8);
});

it('resolves all ServiceResolutionV1 states, scope precedence, version incompatibility, and registration order invariance', async () => {
  const pkgRoot = createTempDir('hm-b1-01-pkg-');
  const sourceDir = writePluginPackage(
    pkgRoot,
    'history-source-sample',
    {
      id: 'user.history.sample',
      name: 'Sample History Source',
      version: '1.0.0',
      apiVersion: 4,
      engines: { pluginApi: '^4.0' },
      category: 'workflow',
      main: 'index.mjs',
      provides: ['history.source.v1'],
      permissions: [],
    },
    {
      'index.mjs': `
export function apply(ctx, config) {
  const ver = typeof config.serviceVersion === 'string' ? config.serviceVersion : '1.0.0';
  const unprovide = ctx.provide('history.source.v1', {
    discover: (req) => ({
      ok: true,
      value: {
        sessions: [{
          ref: { sourceInstanceId: ctx.instanceId, sourceId: 'sample:' + ctx.instanceId, nativeSessionId: 'n1' },
          title: 'From ' + ctx.instanceId,
          harnessKind: 'codex',
          updatedAt: 1795651200000,
        }],
        nextCursor: null,
      },
    }),
    read: ({ ref }) => ({
      ok: true,
      value: { ref, items: [], nextCursor: null, readStatus: 'complete', warnings: [] },
    }),
  }, { version: ver });
  ctx.routes.register('/unprovide', () => {
    unprovide();
    return { status: 200, body: { unprovided: ctx.instanceId } };
  });
}
`,
    },
  );

  const consumerDir = writePluginPackage(
    pkgRoot,
    'history-consumer-sample',
    {
      id: 'user.history.consumer',
      name: 'Sample History Consumer',
      version: '1.0.0',
      apiVersion: 4,
      engines: { pluginApi: '^4.0' },
      category: 'workflow',
      main: 'index.mjs',
      dependencies: {
        source: { contract: 'history.source.v1', version: '^1.0.0', optional: true },
      },
      permissions: [],
    },
    {
      'index.mjs': `
export function apply(ctx) {
  ctx.routes.register('/resolve', async (req) => {
    const res = await ctx.services.resolve('history.source.v1', {
      versionRange: req.query.versionRange,
      sessionId: req.query.sessionId,
      workspaceId: req.query.workspaceId,
      explicitInstanceId: req.query.explicitInstanceId,
      allowSingleCandidate: req.query.allowSingleCandidate === '1',
    });
    return { status: 200, body: res };
  });
  ctx.routes.register('/call', async (req) => {
    const res = await ctx.services.call('history.source.v1', 'discover', [{}], {
      versionRange: req.query.versionRange || '^1.0.0',
      sessionId: req.query.sessionId,
      workspaceId: req.query.workspaceId,
      instanceId: req.query.explicitInstanceId,
      allowSingleCandidate: req.query.allowSingleCandidate === '1',
    });
    return { status: 200, body: res };
  });
}
`,
    },
  );

  // Run the same scenario in forward (a, b) and reversed (b, a) registration orders
  const runScenario = async (order: ['history.sample.a', 'history.sample.b'] | ['history.sample.b', 'history.sample.a']) => {
    const dataDir = createTempDir(`hm-b1-01-${order[0]}-`);
    const wsDir = createTempDir('hm-b1-01-ws-');
    const daemon = await createTestDaemon(dataDir);
    for (const bundledSourceId of [
      'hm.plugin.history-source-codex',
      'hm.plugin.history-source-claude',
      'hm.plugin.history-source-agy-cli',
      'hm.plugin.history-source-agy-desktop',
    ]) {
      await daemon.pluginManager.togglePlugin(bundledSourceId, false);
    }
    const ws = await daemon.sessionManager.addWorkspace(wsDir, 'WS');
    const session = await daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: 'codex', permissionMode: 'manual' });

    // 1. unconfigured
    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', { versionRange: '^1.0.0' })).toEqual({
      contract: 'history.source.v1',
      versionRange: '^1.0.0',
      instanceId: null,
      source: 'none',
      status: 'unconfigured',
      candidates: [],
    });

    await installTrustedDir(daemon, sourceDir);
    await installTrustedDir(daemon, consumerDir);
    await daemon.pluginManager.togglePlugin('user.history.sample', false);

    // Register first instance only -> test single candidate opt-in vs without opt-in
    await daemon.pluginManager.upsertCompositionInstance({
      id: order[0],
      name: 'user.history.sample',
      config: { serviceVersion: '1.0.0' },
    });

    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      allowSingleCandidate: false,
    })).toEqual({
      contract: 'history.source.v1',
      versionRange: '^1.0.0',
      instanceId: null,
      source: 'none',
      status: 'selection_required',
      candidates: [{ instanceId: order[0], pluginId: 'user.history.sample', version: '1.0.0' }],
    });

    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      allowSingleCandidate: true,
    })).toEqual({
      contract: 'history.source.v1',
      versionRange: '^1.0.0',
      instanceId: order[0],
      source: 'single',
      status: 'ready',
      candidates: [{ instanceId: order[0], pluginId: 'user.history.sample', version: '1.0.0' }],
    });

    // Register second instance -> ambiguous even with allowSingleCandidate: true
    await daemon.pluginManager.upsertCompositionInstance({
      id: order[1],
      name: 'user.history.sample',
      config: { serviceVersion: '1.0.0' },
    });
    await daemon.pluginManager.upsertCompositionInstance({
      id: 'consumer.inst',
      name: 'user.history.consumer',
      bindings: { 'history.source.v1': 'history.sample.b' },
    });

    const ambiguous = daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      allowSingleCandidate: true,
    });
    expect(ambiguous).toEqual({
      contract: 'history.source.v1',
      versionRange: '^1.0.0',
      instanceId: null,
      source: 'none',
      status: 'selection_required',
      candidates: [
        { instanceId: 'history.sample.a', pluginId: 'user.history.sample', version: '1.0.0' },
        { instanceId: 'history.sample.b', pluginId: 'user.history.sample', version: '1.0.0' },
      ],
    });

    // Scope priority: composition < dependency < workspace < session < explicit
    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      callerInstanceId: 'consumer.inst',
    })).toMatchObject({ instanceId: 'history.sample.b', source: 'dependency', status: 'ready' });

    await daemon.pluginManager.setWorkspaceBinding(ws.id, 'history.source.v1', 'history.sample.a');
    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      sessionId: session.id,
      callerInstanceId: 'consumer.inst',
    })).toMatchObject({ instanceId: 'history.sample.a', source: 'workspace', status: 'ready' });

    await daemon.pluginManager.setSessionBinding(session.id, 'history.source.v1', 'history.sample.b');
    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      sessionId: session.id,
      workspaceId: ws.id,
      callerInstanceId: 'consumer.inst',
    })).toMatchObject({ instanceId: 'history.sample.b', source: 'session', status: 'ready' });

    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      sessionId: session.id,
      explicitInstanceId: 'history.sample.a',
    })).toMatchObject({ instanceId: 'history.sample.a', source: 'explicit', status: 'ready' });

    // Invoke via isolated ctx.services.resolve and ctx.services.call
    const routeResolve = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/plugin-instances/consumer.inst/routes/resolve?versionRange=${encodeURIComponent('^1.0.0')}&sessionId=${session.id}`,
    });
    expect(routeResolve.statusCode).toBe(200);
    expect(routeResolve.json()).toMatchObject({ instanceId: 'history.sample.b', source: 'session', status: 'ready' });

    const routeCall = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/plugin-instances/consumer.inst/routes/call?sessionId=${session.id}`,
    });
    expect(routeCall.statusCode).toBe(200);
    expect(routeCall.json().value.sessions[0].ref.sourceInstanceId).toBe('history.sample.b');

    // Disable history.sample.a -> workspace binding preserves instanceId with status: 'disabled'
    await daemon.pluginManager.upsertCompositionInstance({
      id: 'history.sample.a',
      name: 'user.history.sample',
      disabled: true,
      config: { serviceVersion: '1.0.0' },
    });
    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      workspaceId: ws.id,
    })).toEqual({
      contract: 'history.source.v1',
      versionRange: '^1.0.0',
      instanceId: 'history.sample.a',
      source: 'workspace',
      status: 'disabled',
      candidates: [{ instanceId: 'history.sample.b', pluginId: 'user.history.sample', version: '1.0.0' }],
    });

    // Re-enable history.sample.a -> restored to ready
    await daemon.pluginManager.upsertCompositionInstance({
      id: 'history.sample.a',
      name: 'user.history.sample',
      disabled: false,
      config: { serviceVersion: '1.0.0' },
    });
    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      workspaceId: ws.id,
    })).toMatchObject({ instanceId: 'history.sample.a', source: 'workspace', status: 'ready' });

    // Version incompatibility: upgrade history.sample.a to 2.0.0 while requesting ^1.0.0
    await daemon.pluginManager.upsertCompositionInstance({
      id: 'history.sample.a',
      name: 'user.history.sample',
      config: { serviceVersion: '2.0.0' },
    });
    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      explicitInstanceId: 'history.sample.a',
    })).toEqual({
      contract: 'history.source.v1',
      versionRange: '^1.0.0',
      instanceId: 'history.sample.a',
      source: 'explicit',
      status: 'incompatible',
      candidates: [{ instanceId: 'history.sample.b', pluginId: 'user.history.sample', version: '1.0.0' }],
    });
    // Incompatible call from isolated consumer maps to E_NOT_SUPPORTED
    const incompatCall = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/plugin-instances/consumer.inst/routes/call?explicitInstanceId=history.sample.a',
    });
    expect(incompatCall.statusCode).toBe(400);
    expect(incompatCall.json().code).toBe('E_NOT_SUPPORTED');

    // Unavailable: missing dependency instance
    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      explicitInstanceId: 'history.sample.missing',
    })).toEqual({
      contract: 'history.source.v1',
      versionRange: '^1.0.0',
      instanceId: 'history.sample.missing',
      source: 'explicit',
      status: 'unavailable',
      candidates: [{ instanceId: 'history.sample.b', pluginId: 'user.history.sample', version: '1.0.0' }],
    });

    // Per-instance service.unprovide cleanup: unproviding history.sample.b leaves history.sample.a untouched
    await daemon.pluginManager.upsertCompositionInstance({
      id: 'history.sample.a',
      name: 'user.history.sample',
      config: { serviceVersion: '1.0.0' },
    });
    const unprovRes = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/plugin-instances/history.sample.b/routes/unprovide',
    });
    expect(unprovRes.statusCode).toBe(200);
    const providersAfterUnprovide = daemon.pluginManager.listServiceProviders('history.source.v1');
    expect(providersAfterUnprovide.map((p) => p.instanceId)).toEqual(['history.sample.a']);
    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      explicitInstanceId: 'history.sample.b',
    }).status).toBe('unavailable');
    expect(daemon.pluginManager.resolveServiceSelection('history.source.v1', {
      versionRange: '^1.0.0',
      explicitInstanceId: 'history.sample.a',
    }).status).toBe('ready');

    // HTTP resolve route helper test
    const fastify = Fastify();
    registerServiceResolutionRoute(fastify, daemon.pluginManager);
    const httpRes = await fastify.inject({
      method: 'GET',
      url: `/api/v1/plugins/services/resolve?contract=history.source.v1&versionRange=${encodeURIComponent('^1.0.0')}&allowSingleCandidate=1`,
    });
    expect(httpRes.statusCode).toBe(200);
    expect(httpRes.json()).toMatchObject({
      contract: 'history.source.v1',
      instanceId: 'history.sample.a',
      source: 'single',
      status: 'ready',
    });
    const badHttpRes = await fastify.inject({ method: 'GET', url: '/api/v1/plugins/services/resolve' });
    expect(badHttpRes.statusCode).toBe(400);
    await fastify.close();

    return ambiguous.candidates.map((c) => c.instanceId);
  };

  const forwardIds = await runScenario(['history.sample.a', 'history.sample.b']);
  const reverseIds = await runScenario(['history.sample.b', 'history.sample.a']);
  expect(forwardIds).toEqual(['history.sample.a', 'history.sample.b']);
  expect(reverseIds).toEqual(forwardIds);
}, 40_000);

it('loads distribution defaults from harnessmate-core data, preserves legacy profile precedence, and handles empty composition recovery', async () => {
  const dataDir = createTempDir('hm-b1-01-comp-');
  const comp = new PluginComposition(dataDir, [
    'hm.plugin.browser-desktop',
    'hm.plugin.browser-headless',
    'hm.plugin.file-preview-text',
    'hm.plugin.file-preview-markdown',
    'hm.plugin.approval-policy-default',
  ]);
  comp.reload([]);
  expect(comp.layerBindings).toEqual({
    'browser.v1': 'hm.plugin.browser-desktop',
    'filePreview.v1': 'hm.plugin.file-preview-text',
    'approval.policy.v1': 'hm.plugin.approval-policy-default',
    'history.import.v1': 'hm.plugin.history-import',
    'session.search.v1': 'hm.plugin.session-search-fts',
    'hm.session-data.v1': 'core.history-session-data',
    'git.checkpoint.v1': 'git',
    'git.workspace.v1': 'git',
    'session.attachments.v1': 'core.attachments',
    'terminal.runner.v1': 'core.terminal-runner',
    'terminal.workspace.v1': 'hm.plugin.terminal-workspace',
    'workspace.files.v1': 'core.terminal-runner',
    'workspace.rules.v1': 'core.workspace-rules',
  });

  // Legacy profile with extensions.filePreviewProvider overrides distribution default
  fs.writeFileSync(
    path.join(dataDir, 'profile.json'),
    JSON.stringify({
      bundles: ['harnessmate-core'],
      extensions: { filePreviewProvider: 'hm.plugin.file-preview-markdown' },
    }),
  );
  comp.reload([]);
  expect(comp.profileBindings['filePreview.v1']).toBe('hm.plugin.file-preview-markdown');
  expect(comp.contractBindings['filePreview.v1']).toBe('hm.plugin.file-preview-markdown');

  // profile.bindings overrides legacy extensions.filePreviewProvider
  fs.writeFileSync(
    path.join(dataDir, 'profile.json'),
    JSON.stringify({
      bundles: ['harnessmate-core'],
      bindings: { 'filePreview.v1': 'user.custom-viewer' },
      extensions: { filePreviewProvider: 'hm.plugin.file-preview-markdown' },
    }),
  );
  comp.reload([]);
  expect(comp.profileBindings['filePreview.v1']).toBe('user.custom-viewer');
  expect(comp.contractBindings['filePreview.v1']).toBe('user.custom-viewer');

  // Legacy resolveCapabilityBinding maps layer default to source: 'default' when enabled, and 'none' when disabled
  const legacyEnabled = resolveCapabilityBinding({
    contract: 'browser.v1',
    composition: comp,
    isEntryInComposition: (id) => id === 'hm.plugin.browser-desktop',
  });
  expect(legacyEnabled).toEqual({
    contract: 'browser.v1',
    instanceId: 'hm.plugin.browser-desktop',
    source: 'default',
  });
  const legacyDisabled = resolveCapabilityBinding({
    contract: 'browser.v1',
    composition: comp,
    isEntryInComposition: () => false,
  });
  expect(legacyDisabled).toEqual({ contract: 'browser.v1', instanceId: null, source: 'none' });

  // Daemon-level empty composition & recovery preserves disabled/unconfigured semantics
  const daemonDir = createTempDir('hm-b1-01-empty-');
  const daemon = await createTestDaemon(daemonDir);
  expect(daemon.pluginManager.resolveServiceSelection('browser.v1')).toMatchObject({
    instanceId: 'hm.plugin.browser-desktop',
    source: 'composition',
    status: 'ready',
  });

  // Disable browser-desktop: legacy returns none, new resolution preserves instanceId + status: 'disabled'
  await daemon.pluginManager.togglePlugin('hm.plugin.browser-desktop', false);
  expect(daemon.pluginManager.resolveCapabilityBinding('browser.v1')).toEqual({
    contract: 'browser.v1',
    instanceId: null,
    source: 'none',
  });
  expect(daemon.pluginManager.resolveServiceSelection('browser.v1')).toMatchObject({
    instanceId: 'hm.plugin.browser-desktop',
    source: 'composition',
    status: 'disabled',
  });

  // Empty composition removes harnessmate-core layer defaults
  await daemon.pluginManager.restoreComposition('empty');
  expect(daemon.pluginManager.resolveServiceSelection('browser.v1')).toEqual({
    contract: 'browser.v1',
    versionRange: '*',
    instanceId: null,
    source: 'none',
    status: 'unconfigured',
    candidates: [],
  });

  // Restore builtin reloads harnessmate-core layer defaults
  await daemon.pluginManager.restoreComposition('builtin');
  expect(daemon.pluginManager.resolveServiceSelection('browser.v1')).toMatchObject({
    instanceId: 'hm.plugin.browser-desktop',
    source: 'composition',
    status: 'ready',
  });
}, 30_000);

it('enforces dependency semver checks in PluginHost and supports trusted-local peer service/route/page parity', async () => {
  const host = new PluginHost();
  host.reconcile([
    {
      id: 'dep.v2',
      enabled: true,
      provides: ['acme.svc'],
      apply: (ctx) => {
        ctx.provide('acme.svc', { ok: true }, { version: '2.0.0' });
      },
    },
    {
      id: 'consumer.v1',
      enabled: true,
      dependencies: [{ contract: 'acme.svc', version: '^1.0.0' }],
      apply: () => {},
    },
  ]);
  expect(host.status('consumer.v1')).toMatchObject({
    state: 'PENDING',
    missingServices: ['acme.svc@^1.0.0'],
  });
  host.reconcile([
    {
      id: 'dep.v2',
      enabled: true,
      provides: ['acme.svc'],
      apply: (ctx) => {
        ctx.provide('acme.svc', { ok: true }, { version: '2.0.0' });
      },
    },
    {
      id: 'dep.v1',
      enabled: true,
      provides: ['acme.svc'],
      apply: (ctx) => {
        ctx.provide('acme.svc', { ok: true }, { version: '1.2.0' });
      },
    },
    {
      id: 'consumer.v1',
      enabled: true,
      dependencies: [{ contract: 'acme.svc', version: '^1.0.0' }],
      apply: () => {},
    },
  ]);
  expect(host.status('consumer.v1')?.state).toBe('ACTIVE');

  // Trusted-local dev plugin provides session.search.v1, route, and workspace.pages slot
  const dataDir = createTempDir('hm-b1-01-trusted-');
  const devRoot = createTempDir('hm-b1-01-dev-');
  const daemon = await createTestDaemon(dataDir);
  const devDir = writePluginPackage(
    devRoot,
    'trusted-search',
    {
      id: 'user.trusted-search',
      name: 'Trusted Search',
      version: '1.0.0',
      apiVersion: 4,
      engines: { pluginApi: '^4.0' },
      category: 'workflow',
      main: 'index.mjs',
      provides: ['session.search.v1'],
      permissions: [],
    },
    {
      'ui/page.html': '<!doctype html><html><body><h1>Trusted Search</h1></body></html>',
      'index.mjs': `
export const requires = ['ui.workspace.pages', 'runtime.trustedLocal'];
export function apply(ctx) {
  ctx.provide('session.search.v1', {
    query: () => ({ ok: true, value: { hits: [], nextOffset: null, fallbackUsed: false, tookMs: 1 } }),
    reindex: () => ({ ok: true, value: { jobId: 'j1', status: 'queued' } }),
  }, { version: '1.0.0' });
  ctx.routes.register('/status', () => ({ status: 200, body: { trustedLocal: ctx.runtime.trustedLocal } }));
  ctx.slots.register({ slot: 'workspace.pages', id: 'session-search', title: 'Trusted Search', ui: 'ui/page.html' });
}
`,
    },
  );
  await daemon.pluginManager.linkDevPlugin(devDir, 'user.trusted-search');
  await daemon.pluginManager.setCompositionBinding('session.search.v1', 'user.trusted-search');
  const resolution = daemon.pluginManager.resolveServiceSelection('session.search.v1', {
    versionRange: '^1.0.0',
  });
  expect(resolution).toMatchObject({
    contract: 'session.search.v1',
    instanceId: 'user.trusted-search',
    source: 'composition',
    status: 'ready',
  });
  const invokeRes = await daemon.pluginManager.invokeServiceSelection<{ ok: boolean; value: { jobId: string } }>(
    'session.search.v1',
    'reindex',
    [{}],
  );
  expect(invokeRes.value).toEqual({ ok: true, value: { jobId: 'j1', status: 'queued' } });
  const routeRes = await daemon.app.inject({
    method: 'GET',
    url: '/api/v1/plugin-instances/user.trusted-search/routes/status',
  });
  expect(routeRes.statusCode).toBe(200);
  expect(routeRes.json()).toEqual({ trustedLocal: true });
  const installed = daemon.pluginManager.listInstalled().find((p) => p.id === 'user.trusted-search');
  expect(installed?.runtimeSlots?.some((s) => s.slot === 'workspace.pages' && s.id === 'session-search')).toBe(true);

  // Scoped env passthrough for fs:cli_histories:read without leaking host secrets
  const prevCodexHome = process.env.CODEX_HOME;
  const prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const prevSecret = process.env.OPENAI_API_KEY;
  process.env.CODEX_HOME = 'D:\\tmp-codex-home';
  process.env.CLAUDE_CONFIG_DIR = 'D:\\tmp-claude-dir';
  process.env.OPENAI_API_KEY = 'sk-should-not-leak';
  try {
    const plainEnv = buildIsolatedChildEnv({ declaredPermissions: ['events:turn'] });
    expect(plainEnv.CODEX_HOME).toBeUndefined();
    expect(plainEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(plainEnv.OPENAI_API_KEY).toBeUndefined();

    const historyEnv = buildIsolatedChildEnv({ declaredPermissions: ['fs:cli_histories:read'] });
    expect(historyEnv.CODEX_HOME).toBe('D:\\tmp-codex-home');
    expect(historyEnv.CLAUDE_CONFIG_DIR).toBe('D:\\tmp-claude-dir');
    expect(historyEnv.OPENAI_API_KEY).toBeUndefined();
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
    if (prevSecret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevSecret;
  }
}, 25_000);
