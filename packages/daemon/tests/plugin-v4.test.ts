import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PluginManifestSchema } from '@harnessmate/plugin-api';
import { normalizePluginManifest } from '../src/plugin-host/manifest/normalize.js';
import { PluginHost, type HostPluginContext } from '../src/plugin-host/runtime/lifecycle.js';
import { PluginEvents, sessionPluginEvent } from '../src/plugin-host/runtime/events.js';
import { toPluginEvent } from '../src/plugin-host/runtime/map-event.js';
import { composeSnapshot } from '../src/core/handoff-snapshot.js';
import { createDaemon } from '../src/server/app.js';
import { readRevisionPointer } from '../src/plugins/plugin-package.js';
import { PluginComposition } from '../src/plugin-host/composition/profile.js';

it('migrates adjacent manifest generations and rejects incompatible API ranges', () => {
  const base = { id: 'fixture.v4', name: 'Fixture', description: '' };
  const read = (fields: Record<string, unknown>) => normalizePluginManifest(PluginManifestSchema.parse({ ...base, ...fields }));
  expect(read({ entry: 'entry.mjs' })).toMatchObject({ apiVersion: 4, main: 'entry.mjs', engines: { pluginApi: '^4.0' } });
  expect(read({ apiVersion: 2, contributes: { projections: [{ id: 'history', scope: 'session', events: ['turn.completed'] }] } }))
    .toMatchObject({ apiVersion: 4, contributes: { projections: [{ id: 'history' }] } });
  expect(read({ apiVersion: 3, contributes: { programs: [{ id: 'clean', description: 'Trim', steps: [{ op: 'trim' }] }] } }))
    .toMatchObject({ apiVersion: 4, contributes: { programs: [{ id: 'clean' }] } });
  expect(read({ apiVersion: 4, engines: { pluginApi: '^4.0' }, inject: ['ledger'] })).toMatchObject({ inject: ['ledger'] });
  expect(() => read({ apiVersion: 5 })).toThrow(expect.objectContaining({ code: 'E_NOT_SUPPORTED' }));
  expect(() => read({ apiVersion: 4, engines: { pluginApi: '^4.1' } })).toThrow(expect.objectContaining({ code: 'E_NOT_SUPPORTED' }));
  expect(() => read({ apiVersion: 4 })).toThrow(expect.objectContaining({ code: 'E_INVALID_INPUT' }));
});

it('starts waiting plugins when a service becomes available and unwinds effects on replacement', async () => {
  const host = new PluginHost();
  const trace: string[] = [];
  let oldContext: HostPluginContext | undefined;
  const consumer = {
    id: 'consumer', enabled: true, inject: ['example.service'],
    apply(ctx: HostPluginContext) {
      oldContext = ctx;
      const value = ctx.get<{ version: string }>('example.service')!.version;
      ctx.effect(() => () => { trace.push(`first:${value}`); });
      ctx.on('session.created', async () => { trace.push(`created:${value}`); });
      ctx.effect(() => () => { trace.push(`last:${value}`); });
    },
  };
  const provider = (revision: string) => ({
    id: 'provider', enabled: true, revision, provides: ['example.service'],
    apply(ctx: HostPluginContext) { ctx.provide('example.service', { version: revision }); },
  });
  host.reconcile([consumer]);
  expect(host.status('consumer')).toMatchObject({ state: 'PENDING', missingServices: ['example.service'] });
  host.reconcile([consumer, provider('one')]);
  const stale = oldContext!;
  const created = sessionPluginEvent('session.created', { id: 'session', title: 'Test', harnessId: 'codex' });
  await host.events.dispatch(created);
  host.reconcile([consumer, provider('two')]);
  expect(trace).toEqual(['created:one', 'last:one', 'first:one']);
  expect(() => stale.get('example.service')).toThrow(expect.objectContaining({ code: 'E_STALE_RUN' }));
  await host.events.dispatch(created);
  host.reconcile([consumer]);
  expect(trace).toEqual(['created:one', 'last:one', 'first:one', 'created:two', 'last:two', 'first:two']);
  await host.events.dispatch(created);
  expect(trace).toHaveLength(6);
  expect(host.status('consumer')?.state).toBe('PENDING');
});

it('maps canonical events to allowlisted DTO fields and hashes only changed snapshot sections', () => {
  expect(toPluginEvent({
    type: 'tool.call.completed', seq: 8, sessionId: 'session', turnId: 'turn', createdAt: 123,
    payload: { toolName: 'git', toolCallId: 'tool', status: 'success', output: 'internal', extra: 1 },
  })).toEqual({
    version: 4, type: 'tool.completed', seq: 8, sessionId: 'session', turnId: 'turn', createdAt: 123,
    data: { toolName: 'git', toolCallId: 'tool', status: 'success' },
  });
  const workspace = { id: 'workspace', source: 'git', text: 'same' };
  const first = composeSnapshot([workspace, { id: 'transcript', source: 'conversation', text: 'first' }]);
  const next = composeSnapshot([workspace, { id: 'transcript', source: 'conversation', text: 'next' }], first);
  expect(next.previousSnapshotId).toBe(first.snapshotId);
  expect(next.sections.map(({ id }) => id)).toEqual(['transcript']);
  expect(next.sectionHashes.workspace).toBe(first.sectionHashes.workspace);
});

it('dispatches serial and parallel sessions, keeps waterfall order, and bails on false', async () => {
  const events = new PluginEvents(() => {});
  const session = { id: 'session', title: 'Test', harnessId: 'codex' };
  const trace: string[] = [];
  events.on('session.created', async () => { await Promise.resolve(); trace.push('serial:one'); });
  events.on('session.created', () => { trace.push('serial:two'); });
  await events.dispatch(sessionPluginEvent('session.created', session));
  events.on('session.closing', async () => { await Promise.resolve(); trace.push('parallel:one'); });
  events.on('session.closing', () => { trace.push('parallel:two'); });
  await events.dispatch(sessionPluginEvent('session.closing', session));
  events.waterfall('handoff.compose', { append: (value: string) => trace.push(value) }, [
    ({ append }, next) => { append('one:enter'); next(); append('one:leave'); },
    ({ append }, next) => { append('two:enter'); next(); },
  ]);
  expect(trace).toEqual(['serial:one', 'serial:two', 'parallel:two', 'parallel:one', 'one:enter', 'two:enter', 'one:leave']);
  expect(events.bail('handoff.shouldOffer', [() => undefined, () => false, () => { throw new Error('must not run'); }])).toBe(false);
});

it('loads bundle and patch settings, persists toggles, and performs actual first-party registration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-v4-composition-'));
  fs.mkdirSync(path.join(root, 'bundles'));
  fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify({ bundles: ['harnessmate-core', 'team'] }));
  fs.writeFileSync(path.join(root, 'bundles', 'team.yml'), '- id: handoff\n  config: {budgetTokens: 16000, autoAttach: true}\n');
  const overlay = path.join(root, 'patch.yml');
  fs.writeFileSync(overlay, '- id: handoff\n  config: {autoAttach: false}\n- id: ledger\n  disabled: true\n');
  let daemon = createDaemon({ dataDir: root, port: 0 });
  const manifest = PluginManifestSchema.parse({
    id: 'fixture.dependent', name: 'Dependent', description: '', apiVersion: 4, engines: { pluginApi: '^4.0' },
    inject: ['ledger'], contributes: { slashCommands: [{ command: 'compose-test', description: '', template: 'Confirmed {{args}}' }] },
  });
  try {
    await daemon.start();
    await daemon.pluginManager.installPlugin({ mode: 'manifest', manifest });
    expect(daemon.pluginManager.listInstalled().find(({ id }) => id === manifest.id))
      .toMatchObject({ runtimeState: 'PENDING', missingServices: ['ledger'] });
    expect(daemon.pluginManager.expandSlashCommand('/compose-test input').text).toBe('/compose-test input');
    expect(daemon.pluginManager.getComposition().entries.find(({ id }) => id === 'handoff')).toMatchObject({
      config: { budgetTokens: 16000, autoAttach: false }, sources: ['harnessmate-core', 'team', 'patch.yml'],
    });
    await daemon.pluginManager.togglePlugin('core.task-ledger', true);
    expect(daemon.pluginManager.expandSlashCommand('/compose-test $&').text).toBe('Confirmed $&');
    expect(daemon.pluginManager.host.get('handoff')).toMatchObject({ options: { budgetTokens: 16000, autoAttach: false } });
    const adapter = daemon.registry.get('codex');
    await daemon.pluginManager.togglePlugin('core.harness.codex', false);
    expect(daemon.registry.get('codex')).toBeUndefined();
    await daemon.pluginManager.togglePlugin('core.harness.codex', true);
    expect(daemon.registry.get('codex')).toBeDefined();
    expect(daemon.registry.get('codex')).not.toBe(adapter);
    await daemon.stop();
    daemon = createDaemon({ dataDir: root, port: 0 });
    await daemon.start();
    expect(daemon.pluginManager.isPluginEnabled(manifest.id)).toBe(true);
    expect(fs.readFileSync(overlay, 'utf8')).not.toContain('id: ledger');
  } finally {
    await daemon.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('requires digest-bound confirmation for pasted and catalog CLI contributions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-v4-trust-'));
  let daemon = createDaemon({ dataDir: root, port: 0 });
  try {
    await daemon.start();
    const manifest = PluginManifestSchema.parse({
      id: 'fixture.acp', name: 'ACP', description: '',
      contributes: { harnesses: [{ id: 'test-acp', command: 'example-acp', displayName: 'Example ACP' }] },
    });
    const request = { mode: 'manifest', manifest } as const;
    const preview = daemon.pluginManager.previewInstall(request);
    expect(preview.requiresTrust).toBe(true);
    await expect(daemon.pluginManager.installPlugin(request)).rejects.toThrow('确认信任');
    await expect(daemon.pluginManager.installPlugin({ ...request, trustCode: true, expectedDigest: '0'.repeat(64) }))
      .rejects.toThrow('文件已更改');
    expect(daemon.registry.get('test-acp')).toBeUndefined();
    await daemon.pluginManager.installPlugin({ ...request, trustCode: true, expectedDigest: preview.digest });
    expect(daemon.registry.get('test-acp')).toBeDefined();
    const catalog = { mode: 'catalog', catalogId: 'ext.mcp-devtools-pack' } as const;
    expect(daemon.pluginManager.previewInstall(catalog).requiresTrust).toBe(true);
    await expect(daemon.pluginManager.installPlugin(catalog)).rejects.toThrow('确认信任');
    await daemon.stop();
    daemon = createDaemon({ dataDir: root, port: 0 });
    await daemon.start();
    expect(daemon.registry.get('test-acp')).toBeDefined();
  } finally {
    await daemon.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('starts with builtins in safe mode and restores a damaged composition for the next launch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-plugin-recovery-'));
  const patch = path.join(root, 'patch.yml');
  const manifest = PluginManifestSchema.parse({
    id: 'fixture.recovery', name: 'Recovery fixture', description: '', apiVersion: 4,
    engines: { pluginApi: '^4.0' }, main: 'index.mjs',
    contributes: { slashCommands: [{ command: 'recovery-test', description: '', template: 'Active {{args}}' }] },
  });
  let daemon = createDaemon({ dataDir: root, port: 0 });
  try {
    await daemon.start();
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'harnessmate-plugin.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(source, 'index.mjs'), 'export function apply() {}\n');
    const request = { mode: 'local_dir', dirPath: source } as const;
    const preview = daemon.pluginManager.previewInstall(request);
    await daemon.pluginManager.installPlugin({ ...request, trustCode: true, expectedDigest: preview.digest });
    expect(daemon.pluginManager.isolated?.getRunId(manifest.id)).toBeDefined();
    expect(daemon.pluginManager.expandSlashCommand('/recovery-test yes').text).toBe('Active yes');
    await daemon.pluginManager.togglePlugin('core.harness.codex', false);
    const profile = fs.readFileSync(path.join(root, 'profile.json'), 'utf8');
    await daemon.stop();
    const damagedPatch = '- id: [';
    fs.writeFileSync(patch, damagedPatch);

    daemon = createDaemon({ dataDir: root, port: 0, pluginSafeMode: true });
    await daemon.start();
    expect((await daemon.app.inject('/api/v1/health')).json()).toMatchObject({ pluginSafeMode: true });
    expect(daemon.pluginManager.getComposition()).toMatchObject({ safeMode: true, canRestore: true, error: expect.any(String) });
    expect(daemon.pluginManager.isolated?.getRunId(manifest.id)).toBeUndefined();
    expect(daemon.pluginManager.expandSlashCommand('/recovery-test yes').text).toBe('/recovery-test yes');
    expect(daemon.registry.get('codex')).toBeDefined();
    expect(fs.readFileSync(patch, 'utf8')).toBe(damagedPatch);
    expect(fs.readFileSync(path.join(root, 'profile.json'), 'utf8')).toBe(profile);
    const response = await daemon.app.inject({
      method: 'POST', url: '/api/v1/plugins/composition/restore', payload: { source: 'previous' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(daemon.pluginManager.getComposition().error).toBeUndefined();
    expect(daemon.pluginManager.isPluginEnabled(manifest.id)).toBe(false);
    await expect(daemon.pluginManager.togglePlugin(manifest.id, true)).rejects.toThrow('安全模式');
    await daemon.pluginManager.togglePlugin(manifest.id, false);
    await daemon.stop();

    daemon = createDaemon({ dataDir: root, port: 0 });
    await daemon.start();
    expect(daemon.pluginManager.getComposition().safeMode).toBe(false);
    expect(daemon.registry.get('codex')).toBeDefined();
    expect(daemon.pluginManager.isPluginEnabled(manifest.id)).toBe(false);
  } finally {
    await daemon.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it('completes an interrupted composition restore on normal startup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-composition-restore-'));
  try {
    const journal = path.join(root, 'plugin-composition.restore.json');
    fs.writeFileSync(path.join(root, 'profile.json'), '{"bundles":["broken"]}');
    fs.writeFileSync(path.join(root, 'patch.yml'), 'broken: [');
    fs.writeFileSync(journal, JSON.stringify({
      bundles: ['harnessmate-core'], patch: [{ id: 'ledger', disabled: true }],
    }));
    const composition = new PluginComposition(root, ['core.task-ledger']);
    expect(() => composition.reload([], true)).toThrow('找不到组合包');
    expect(fs.existsSync(journal)).toBe(true);
    composition.reload([]);
    expect(fs.existsSync(journal)).toBe(false);
    expect(composition.resolve([]).entries[0]).toMatchObject({ id: 'ledger', disabled: true });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'profile.json'), 'utf8'))).toEqual({ bundles: ['harnessmate-core'] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('keeps the active revision when a rollback candidate cannot start', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-plugin-rollback-'));
  const pluginId = 'fixture.rollback-recovery';
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.mjs'), 'export function apply() {}\n');
  const daemon = createDaemon({ dataDir: root, port: 0 });
  try {
    await daemon.start();
    for (const version of ['1.0.0', '2.0.0']) {
      fs.writeFileSync(path.join(source, 'harnessmate-plugin.json'), JSON.stringify({
        id: pluginId, name: 'Rollback fixture', description: '', version, apiVersion: 4,
        engines: { pluginApi: '^4.0' }, main: 'index.mjs', inject: version === '1.0.0' ? ['ledger'] : [],
      }));
      const request = { mode: 'local_dir', dirPath: source } as const;
      const preview = daemon.pluginManager.previewInstall(request);
      await daemon.pluginManager.installPlugin({ ...request, trustCode: true, expectedDigest: preview.digest });
    }
    const pluginRoot = path.join(daemon.paths.pluginsDir, pluginId);
    const pointer = readRevisionPointer(pluginRoot);
    expect(pointer?.previous).toBeDefined();
    await daemon.pluginManager.togglePlugin('core.task-ledger', false);
    await expect(daemon.pluginManager.rollbackPlugin(pluginId)).rejects.toThrow('回退版本未就绪');
    expect(readRevisionPointer(pluginRoot)).toEqual(pointer);
    expect(daemon.pluginManager.listInstalled().find(({ id }) => id === pluginId))
      .toMatchObject({ version: '2.0.0', runtimeState: 'ACTIVE' });
    await daemon.pluginManager.togglePlugin('core.task-ledger', true);
    await daemon.pluginManager.rollbackPlugin(pluginId);
    expect(daemon.pluginManager.listInstalled().find(({ id }) => id === pluginId))
      .toMatchObject({ version: '1.0.0', runtimeState: 'ACTIVE' });
  } finally {
    await daemon.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
