import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.W3_FIXTURE_ROOT;
if (!root || !path.isAbsolute(root) || (process.platform === 'win32' && !/^d:/i.test(root))) {
  throw new Error('Set W3_FIXTURE_ROOT to an absolute scratch directory on D:');
}
fs.mkdirSync(root, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(root, 'w3-daemon-'));
const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
process.env.HARNESSMATE_BUNDLES_DIR = path.join(checkout, 'packages/daemon/src/plugin-host/composition');
const { createDaemon } = await import('../../dist/server/app.js');

const makeAdapter = (id, usedPercent) => {
  const capabilities = {
    streaming: true, interactiveApproval: false, reasoningEfforts: [],
    permissionModes: ['manual'], sessionResume: false, sessionFork: false,
    imageInput: false, subagents: false,
  };
  const identity = { id, kind: 'codex', driverId: 'codex', displayName: id, description: id, protocolLabel: 'W3 fixture', capabilities };
  return {
    ...identity,
    async probe() {
      return {
        ...identity, binaryPath: null, version: 'fixture', health: 'ready',
        models: [{ id: `model-${id}`, displayName: id }],
      };
    },
    async readUsageLimits() {
      return {
        loggedIn: true, accountLabel: id, authMethod: 'fixture', billingTier: 'subscription', planType: null,
        rateLimits: [{ label: 'fixture', usedPercent, windowMinutes: 60 }],
      };
    },
    async createSession() {
      const listeners = new Set();
      const emit = (event) => { for (const listener of listeners) listener(event); };
      return {
        nativeSessionId: id,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async sendTurn({ turnId, text }) {
          emit({ type: 'turn.started', turnId });
          if (usedPercent >= 90) {
            emit({ type: 'turn.failed', turnId, code: 'usage_limit', message: 'fixture quota exceeded' });
          } else {
            emit({ type: 'message.assistant.completed', turnId, text: `fixture replay: ${text}` });
            emit({ type: 'turn.completed', turnId, stopReason: 'end_turn' });
          }
        },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() {},
      };
    },
  };
};

const a = makeAdapter('fixture-a', 90);
const b = makeAdapter('fixture-b', 17);
const daemon = createDaemon({ dataDir, bundledPluginsDir: path.join(checkout, 'plugins/bundled'), customAdapters: [a, b] });
const api = (url, method = 'GET', payload) => daemon.app.inject({ url, method, payload });
const modelTools = 'session.model-tools.v1';
const routerId = 'core.session-model-tools';
const forkRouterId = 'fixture.model-tools';
try {
  await daemon.pluginManager.reloadAll();
  const ws = await daemon.sessionManager.addWorkspace(dataDir);
  const sessions = await Promise.all([a, b].map(({ id }) =>
    daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: id, permissionMode: 'manual' })));
  for (const [index, session] of sessions.entries()) {
    const result = await api(`/api/v1/sessions/${session.id}/model-candidates`);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().models[0].id, `model-${[a, b][index].id}`);
    assert.equal(result.json().resolution.instanceId, 'usage');
  }
  const usage = daemon.pluginManager.host.getServiceByInstance('usage', 'harness.usage.v1');
  const quotas = await Promise.all([a, b].map(({ id }) => usage.collectInstanceUsage(id)));
  assert.deepEqual(quotas.map(({ accountLabel, rateLimits }) => [accountLabel, rateLimits[0].usedPercent]),
    [[a.id, 90], [b.id, 17]]);
  const [one, two] = sessions;
  const policyURL = '/api/v1/usage/failover-policy';
  const policy = (await api(policyURL)).json().policy;
  assert.equal((await api(policyURL, 'PUT', { ...policy, priorityChain: [b.id] })).statusCode, 200);
  const suggestion = (await api(`/api/v1/sessions/${one.id}/failover-recommendation`)).json().recommendation;
  assert.equal(suggestion.recommendedInstanceId, b.id);
  assert.equal(daemon.store.getSession(one.id).harnessId, a.id);
  assert.deepEqual(daemon.store.getPluginStorageValue('global', 'core.auto-failover', 'failover_policy').priorityChain, [b.id]);

  const setInstance = (id, disabled) =>
    api('/api/v1/plugins/composition/instances', 'PUT', { id, name: routerId, disabled });
  assert.equal((await setInstance(forkRouterId, false)).statusCode, 200);
  assert.equal((await api(`/api/v1/sessions/${two.id}/bindings`, 'PUT', { contract: modelTools, instanceId: forkRouterId })).statusCode, 200);
  const routerA = daemon.pluginManager.host.getServiceByInstance(routerId, modelTools);
  const routerB = daemon.pluginManager.host.getServiceByInstance(forkRouterId, modelTools);
  assert.ok(routerA && routerB);
  const leaseA = routerA.prepareLease(one, one.harnessId, [], () => true);
  const leaseB = routerB.prepareLease(two, two.harnessId, [], () => true);
  assert.notEqual(leaseA.connection.token, leaseB.connection.token);
  const ping = (lease) => daemon.app.inject({
    url: '/api/v1/plugin-tools', method: 'POST', headers: { authorization: `Bearer ${lease.connection.token}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  assert.equal((await ping(leaseA)).statusCode, 200);
  assert.equal((await ping(leaseB)).statusCode, 200);
  assert.equal((await setInstance(forkRouterId, true)).statusCode, 200);
  assert.equal((await ping(leaseB)).statusCode, 403);
  assert.equal((await ping(leaseA)).statusCode, 200);
  assert.equal((await setInstance(forkRouterId, false)).statusCode, 200);
  assert.equal((await ping(leaseB)).statusCode, 403);
  const nextRouter = daemon.pluginManager.host.getServiceByInstance(forkRouterId, modelTools);
  const nextLease = nextRouter.prepareLease(two, two.harnessId, [], () => true);
  assert.equal((await ping(nextLease)).statusCode, 200);
  nextLease.release();
  assert.equal((await ping(nextLease)).statusCode, 403);

  const fixturePlugin = 'hm.plugin.w3-account-usage-fixture';
  const fixturePath = path.join(checkout, 'plugins/examples', fixturePlugin);
  const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: fixturePath });
  await daemon.pluginManager.installPlugin({
    mode: 'local_dir', dirPath: fixturePath, trustCode: true,
    expectedDigest: preview.digest, expectedInstalledDigest: preview.installedDigest,
  });
  const grant = await api(`/api/v1/plugins/${fixturePlugin}/permissions`, 'PUT', {
    workspaceId: '__global__', capability: 'service:provide:harness.usage.v1',
    digest: preview.digest, granted: true,
  });
  assert.equal(grant.statusCode, 200, grant.body);
  const bound = await api(`/api/v1/sessions/${two.id}/bindings`, 'PUT', {
    contract: 'harness.usage.v1', instanceId: fixturePlugin,
  });
  assert.equal(bound.statusCode, 200, bound.body);
  const selection = daemon.pluginManager.resolveServiceSelection('harness.usage.v1', { sessionId: two.id });
  assert.equal(selection.status, 'ready');
  assert.equal(selection.instanceId, fixturePlugin);
  assert.equal(daemon.pluginManager.resolveServiceSelection('harness.usage.v1', { sessionId: one.id }).instanceId, 'usage');
  const alternative = await api(`/api/v1/usage/accounts?sessionId=${two.id}`);
  assert.equal(alternative.statusCode, 200, alternative.body);
  assert.equal(alternative.json().accounts[0].instanceId, 'fixture-account');
  const page = await api(`/api/v1/plugins/${fixturePlugin}/ui-doc?path=ui%2Fusage.html`);
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.json().html, /读取示例额度/);
  const viewData = await api(`/api/v1/plugin-instances/${fixturePlugin}/routes/accounts`);
  assert.equal(viewData.statusCode, 200, viewData.body);
  assert.equal(viewData.json().instanceId, fixturePlugin);

  const fixtureAlias = 'fixture.account-usage';
  for (const id of [fixturePlugin, fixtureAlias]) {
    const instance = await api('/api/v1/plugins/composition/instances', 'PUT', { id, name: fixturePlugin });
    assert.equal(instance.statusCode, 200, instance.body);
  }
  const toolGrant = await api(`/api/v1/plugins/${fixturePlugin}/permissions`, 'PUT', {
    workspaceId: ws.id, capability: 'tools:model', digest: preview.digest, granted: true,
  });
  assert.equal(toolGrant.statusCode, 200, toolGrant.body);
  const currentRouter = daemon.pluginManager.host.getServiceByInstance(forkRouterId, modelTools);
  const availableTools = currentRouter.list(two).filter(({ pluginId }) => pluginId === fixturePlugin);
  assert.deepEqual(availableTools.map(({ instanceId }) => instanceId).sort(), [fixtureAlias, fixturePlugin].sort());
  assert.equal(new Set(availableTools.map(({ name }) => name)).size, 2);
  const identityLease = currentRouter.prepareLease(two, two.harnessId, availableTools, () => true);
  daemon.store.updateSession(two.id, { status: 'running' });
  for (const tool of availableTools) {
    const result = await daemon.app.inject({
      url: '/api/v1/plugin-tools', method: 'POST',
      headers: { authorization: `Bearer ${identityLease.connection.token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool.name, arguments: {} } },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json().result.content, [{ type: 'text', text: tool.instanceId }], result.body);
  }
  daemon.store.updateSession(two.id, { status: 'idle' });
  identityLease.release();

  await daemon.sessionManager.sendTurn(one.id, 'W3 replay fixture');
  assert.equal(daemon.store.getSession(one.id).status, 'error');
  const switching = await api(`/api/v1/sessions/${one.id}/failover`, 'POST', {
    targetHarnessId: b.id,
    retryLastFailedTurn: true,
  });
  assert.equal(switching.statusCode, 200, switching.body);
  assert.ok(switching.json().retriedTurnId);
  assert.equal(daemon.store.getSession(one.id).harnessId, b.id);
  assert.ok(daemon.sessionManager.getSessionEvents(one.id, 0)
    .some((event) => event.payload.text === 'fixture replay: W3 replay fixture'));

  const alternatePolicy = 'fixture.failover';
  assert.equal((await api('/api/v1/plugins/composition/instances', 'PUT', {
    id: alternatePolicy, name: 'core.auto-failover',
  })).statusCode, 200);
  assert.equal((await api(`/api/v1/sessions/${two.id}/bindings`, 'PUT', {
    contract: 'session.failover.v1', instanceId: alternatePolicy,
  })).statusCode, 200);
  assert.equal((await api(`${policyURL}?sessionId=${two.id}`, 'PUT', { ...policy, priorityChain: [a.id] })).statusCode, 200);
  assert.deepEqual((await api(policyURL)).json().policy.priorityChain, [b.id]);
  assert.deepEqual((await api(`${policyURL}?sessionId=${two.id}`)).json().policy.priorityChain, [a.id]);

  await daemon.pluginManager.restoreComposition('empty');
  assert.equal((await api('/api/v1/usage/accounts')).statusCode, 409);
  assert.equal((await api('/api/v1/mcp/servers')).statusCode, 409);
  assert.equal((await api(`/api/v1/sessions/${one.id}/model-candidates`)).statusCode, 409);
  assert.equal((await ping(leaseA)).statusCode, 403);
  assert.ok(daemon.store.getSession(one.id));
  await daemon.pluginManager.restoreComposition('previous');
  assert.equal((await api(`/api/v1/sessions/${one.id}/model-candidates`)).statusCode, 200);
  assert.deepEqual((await api(policyURL)).json().policy.priorityChain, [b.id]);

  console.log(JSON.stringify({
    result: 'passed', dataDir,
    checks: ['quotas', 'models', 'legacy and isolated policies', 'recommendation', 'parallel leases', 'stop/restart', 'external service and page', 'isolated tool identity', 'confirmed failover and replay', 'empty/previous composition'],
  }));
} finally {
  await daemon.stop();
}
