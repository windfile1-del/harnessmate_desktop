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
