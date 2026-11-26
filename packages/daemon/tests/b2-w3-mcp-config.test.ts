import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, expect, it, vi } from 'vitest';
import { McpService } from '../src/core/mcp-service.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import type { HarnessAdapter } from '../src/harnesses/types.js';
import { execCliQuick } from '../src/harnesses/process.js';

vi.mock('../src/harnesses/process.js', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('../src/harnesses/process.js')>(),
  resolveBinary: async (_id: string, binary?: string) => binary,
  execCliQuick: vi.fn<typeof execCliQuick>(),
}));

beforeEach(() => vi.resetAllMocks());

it('serializes concurrent config writes by native path and retries only failed accounts', async () => {
  const registry = new HarnessRegistry();
  const homeA = path.join(tmpdir(), 'w3-native-account-a');
  const homeB = path.join(tmpdir(), 'w3-native-account-b');
  registry.registerDriver('codex', ({ instanceId }) => ({
    id: instanceId, kind: 'codex', displayName: instanceId,
  }) as HarnessAdapter);
  registry.registerInstance({ instanceId: 'account-a', driverId: 'codex', homeDir: homeA, binaryPath: 'fixture-codex', enabled: true });
  registry.registerInstance({ instanceId: 'account-alias', driverId: 'codex', homeDir: homeA, binaryPath: 'fixture-codex', enabled: true });
  registry.registerInstance({ instanceId: 'account-b', driverId: 'codex', homeDir: homeB, binaryPath: 'fixture-codex', enabled: true });

  const records = new Map<string, Set<string>>();
  const busy = new Set<string>();
  let failAccountB = true;
  vi.mocked(execCliQuick).mockImplementation(async (_binary, args, _timeout, options) => {
    const home = options?.env?.CODEX_HOME;
    if (!home) throw new Error('Fixture must use an isolated account');
    expect(busy.has(home)).toBe(false);
    busy.add(home);
    try {
      const current = records.get(home) ?? new Set<string>();
      const snapshot = new Set(current);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (args[1] === 'list') {
        return {
          stdout: [...current].map((name) => `${name}  http://127.0.0.1:1/mcp  -  enabled  Unknown`).join('\n'),
          stderr: '', exitCode: 0,
        };
      }
      if (home === homeB && failAccountB) return { stdout: '', stderr: 'injected write failure', exitCode: 1 };
      if (args[1] === 'remove') snapshot.delete(args[2]!);
      else snapshot.add(args[2]!);
      records.set(home, snapshot);
      return { stdout: '', stderr: '', exitCode: 0 };
    } finally {
      busy.delete(home);
    }
  });

  const installed = new McpService(registry);
  const parallel = new McpService(registry);
  const add = (manager: McpService, name: string, targetHarnesses: string[]) =>
    manager.addServer({ name, targetHarnesses, url: 'http://127.0.0.1:1/mcp', transport: 'http', args: [] });
  const [{ results }, alias] = await Promise.all([
    add(installed, 'shared', ['account-a', 'account-b']),
    add(parallel, 'concurrent', ['account-alias']),
  ]);
  expect(alias.results[0]?.ok).toBe(true);
  expect(results).toMatchObject([{ harnessId: 'account-a', ok: true }, { harnessId: 'account-b', ok: false }]);
  expect(await installed.listAllServers(['account-a', 'account-b'])).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'account-a:shared' }),
    expect.objectContaining({ id: 'account-a:concurrent' }),
  ]));
  expect(await installed.listAllServers(['account-b'])).toEqual([]);

  failAccountB = false;
  expect((await add(installed, 'shared', results.filter(({ ok }) => !ok).map(({ harnessId }) => harnessId))).results)
    .toMatchObject([{ harnessId: 'account-b', ok: true }]);
  expect(await parallel.removeServer('account-a', 'shared')).toMatchObject({ ok: true });
  expect(await parallel.toggleServer({ harnessId: 'account-a', name: 'concurrent', enabled: false })).toMatchObject({ ok: false });
  installed.stop();
  await expect(installed.listAllServers(['account-b'])).rejects.toMatchObject({ code: 'E_SERVICE_UNAVAILABLE' });
  expect(await parallel.listAllServers(['account-b'])).toMatchObject([{ id: 'account-b:shared' }]);
});

it('retains AGY enablement in the native config across manager restarts', async () => {
  vi.stubEnv('GEMINI_HOME', path.join(tmpdir(), 'w3-agy-account'));
  let enabled = true;
  vi.mocked(execCliQuick).mockImplementation(async (_binary, args) => {
    if (args[1] === 'disable') enabled = false;
    if (args[1] === 'enable') enabled = true;
    return {
      stdout: args[1] === 'list' ? `fixture  http  ${enabled ? 'enabled' : 'disabled'}  http://localhost:1/mcp` : '',
      stderr: '', exitCode: 0,
    };
  });
  const registry = new HarnessRegistry();
  const binaryOverrides = { agy: 'fixture-agy' };
  try {
    const first = new McpService(registry, binaryOverrides);
    expect(await first.toggleServer({ harnessId: 'agy', name: 'fixture', enabled: false })).toMatchObject({ ok: true });
    first.stop();
    const second = new McpService(registry, binaryOverrides);
    expect(await second.listAllServers(['agy'])).toMatchObject([{ id: 'agy:fixture', status: 'disabled' }]);
    expect(await second.toggleServer({ harnessId: 'agy', name: 'fixture', enabled: true })).toMatchObject({ ok: true });
    expect(await second.listAllServers(['agy'])).toMatchObject([{ id: 'agy:fixture', status: 'enabled' }]);
  } finally {
    vi.unstubAllEnvs();
  }
});
