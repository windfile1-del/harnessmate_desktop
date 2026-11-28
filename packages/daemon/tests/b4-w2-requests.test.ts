import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedAdapterEvent, AdapterSessionConfig } from '../src/harnesses/types.js';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { DaemonEventBus } from '../src/core/event-bus.js';
import { RequestBroker } from '../src/plugins/requests-default/index.js';
import type { PluginManager } from '../src/plugins/plugin-manager.js';
import { createDaemon } from '../src/server/app.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(manager?: PluginManager) {
  const store = new HarnessMateStore(':memory:');
  store.createWorkspace({ id: 'w', name: 'W', rootPath: os.tmpdir(), isGitRepo: false, gitBranch: null, createdAt: 1 });
  store.createSession({ id: 's', workspaceId: 'w', harnessId: 'test', harnessKind: 'acp', nativeSessionId: 'native', cwd: os.tmpdir(),
    worktreeBranch: null, title: 'S', status: 'idle', model: null, reasoningEffort: null, permissionMode: 'manual', lastSeq: 0, createdAt: 1, updatedAt: 1 });
  const deps = { store, eventBus: new DaemonEventBus(), getPluginManager: () => manager ?? ({ resolveCapabilityBinding: () => ({ instanceId: null }) }) as unknown as PluginManager };
  const broker = new RequestBroker(deps, 'requests');
  cleanup.push(() => { broker.stop(); store.close(); });
  const register = (id: string, deliver = async (_input: any) => 'acknowledged' as const, deadline = Date.now() + 10000, kind = 'command_approval') => broker.register({
    approval: { id, sessionId: 's', nativeRequestId: id, kind, toolName: 'test', toolKind: 'shell', summary: 'test', input: {},
      riskLevel: 'low', supportedDecisions: ['allow_once','deny'], status: 'pending', decision: null, createdAt: Date.now() },
    workspaceId: 'w', origin: { providerInstanceId: 'driver-a', driverGeneration: 'generation-1', nativeRequestId: id, turnId: 'turn-1', connectionId: 'connection-1' },
    deadlineAtMs: deadline, idempotencyKey: id }, { deliver });
  return { store, broker, deps, register };
}
describe('B4-W2 request facts, decision CAS and execution outbox', () => {
  it('delivers public SDK resource references only to the original instance and run', async () => {
    let runId = 'original-run'; let writes = 0; let released = 0;
    const pm = { resolveCapabilityBinding: () => ({instanceId:null}), host: {
      onServicesChanged: () => () => {}, getServiceRecordByInstance: () => ({runId}),
      getServiceByInstance: () => ({validate:async()=>({ok:true,value:{valid:true}}),
        deliver:async()=>{writes++;return {ok:true,value:{delivery:'acknowledged'}};},release:async()=>{released++;return {ok:true,value:{released:true}};}}),
    }} as unknown as PluginManager;
    const {broker} = fixture(pm);
    const input = {workspaceId:'w',approval:{id:'public',sessionId:'s',kind:'command_approval',nativeRequestId:'wire',summary:'Public resource',toolName:'test',toolKind:'shell',riskLevel:'low',input:{},status:'pending',createdAt:Date.now()},
      origin:{providerInstanceId:'driver',driverGeneration:runId,nativeRequestId:'wire',turnId:null},deadlineAtMs:Date.now()+10000,idempotencyKey:'public',deliveryResource:{instanceId:'driver',runId,resourceId:'opaque-resource'}};
    expect((await broker.service.create(input)).ok).toBe(true);
    await broker.resolve({requestId:'public',actor:'desktop',decision:'allow_once'});
    expect(writes).toBe(1);expect(released).toBe(1);
    await broker.service.create({...input,approval:{...input.approval,id:'stale-resource'},idempotencyKey:'stale-resource'});
    runId='new-run';
    await expect(broker.resolve({requestId:'stale-resource',actor:'desktop',decision:'allow_once'})).rejects.toThrow('失效');
    expect(writes).toBe(1);
  });
  it('commits one multi-client/policy/deadline decision, keeps projection consistent and rejects duplicate/late versions', async () => {
    const { store, broker, register } = fixture(); let writes = 0;
    const fact = register('race', async () => { writes++; await delay(); return 'acknowledged'; });
    expect(store.getSession('s')?.pendingApprovalCount).toBe(1);
    expect(store.getSession('s')?.status).toBe('awaiting_approval');
    const results = await Promise.all(['desktop','mobile','auto'].map(actor => broker.resolve({ requestId: fact.requestId, expectedVersion: 1, actor: actor as any, decision: 'allow_once' })));
    expect(results.filter(r => r.accepted)).toHaveLength(1); expect(writes).toBe(1);
    expect(broker.terminate('race','expired','competing_deadline')).toBe(false);
    expect(broker.get('race')?.delivery).toBe('acknowledged');
    expect(store.getSession('s')?.pendingApprovalCount).toBe(0); expect(store.getSession('s')?.status).toBe('idle');
    expect((await broker.resolve({ requestId: 'race', actor: 'mobile', decision: 'deny' })).conflict).toBe(true);
  });
  it('expires before snapshot, persists display close and repairs restart without writing to any new connection', async () => {
    const { broker, deps, register, store } = fixture(); let writes = 0;
    register('expired', async () => { writes++; return 'acknowledged'; }, Date.now() + 5);
    await delay(); expect(broker.list()).toHaveLength(0); expect(writes).toBe(1);
    expect(broker.close('expired')).toBe(true);
    register('restart', async () => { writes++; return 'acknowledged'; });
    const restarted = new RequestBroker(deps, 'requests');
    cleanup.push(() => restarted.stop());
    expect(restarted.list()).toHaveLength(0); expect(restarted.get('expired')?.closed).toBe(true);
    expect(restarted.get('restart')?.status).toBe('cancelled'); expect(writes).toBe(1);
    expect(store.getSession('s')?.pendingApprovalCount).toBe(0);
  });
  it('retains ambiguous send results across restart and never retries side effects', async () => {
    const { broker, deps, register } = fixture(); let writes = 0;
    register('uncertain', async () => { writes++; throw new Error('write outcome unknown'); });
    await broker.resolve({ requestId: 'uncertain', actor: 'desktop', decision: 'allow_once' });
    expect(broker.get('uncertain')?.status).toBe('approved'); expect(broker.get('uncertain')?.delivery).toBe('unknown');
    const restarted = new RequestBroker(deps, 'requests'); cleanup.push(() => restarted.stop());
    expect(restarted.get('uncertain')?.delivery).toBe('unknown');
    expect((await restarted.resolve({ requestId: 'uncertain', actor: 'mobile', decision: 'allow_once' })).conflict).toBe(true); expect(writes).toBe(1);
  });
  it('recovers a crash during sending as unknown without delivering again', async () => {
    const { broker, deps, register, store } = fixture();
    register('sending');
    await broker.resolve({ requestId: 'sending', actor: 'desktop', decision: 'allow_once' });
    store.getDatabaseSync().prepare("UPDATE request_facts SET delivery='sending' WHERE request_id='sending'").run();
    const restarted = new RequestBroker(deps, 'requests'); cleanup.push(() => restarted.stop());
    expect(restarted.get('sending')?.status).toBe('approved'); expect(restarted.get('sending')?.delivery).toBe('unknown');
    expect(restarted.list()).toHaveLength(0);
  });
  it('keeps questions/credentials typed, forbids scope invention, and emits only sanitized credential receipts', async () => {
    const { register, broker, store } = fixture(); let secret: string | undefined;
    register('secret', async input => { secret = input.secretValue; return 'acknowledged'; }, undefined, 'secret_request');
    await expect(broker.resolve({ requestId: 'secret', actor: 'auto', decision: 'allow_once', secretValue: 'never-auto' })).rejects.toThrow();
    await broker.resolve({ requestId: 'secret', actor: 'desktop', secretValue: 'credential-123', comment: 'credential-123' });
    expect(secret).toBe('credential-123');
    expect(JSON.stringify(store.getEventsAfter('s'))).not.toContain('credential-123');
    expect(JSON.stringify(store.listTurnItems('s'))).not.toContain('credential-123');
    register('scope'); await expect(broker.resolve({ requestId: 'scope', actor: 'desktop', decision: 'allow_session' })).rejects.toThrow('范围');
  });
});

it('records actual driver acceptance, rejection and deferred mode changes through the runtime config path', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b4w2-modes-'));
  const daemon = createDaemon({ dataDir, port: 0, webDistDir: null });
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true })); cleanup.push(() => daemon.stop());
  await daemon.start();
  let emit: ((event: NormalizedAdapterEvent) => void) | undefined;
  let outcome: 'silent' | 'rejected' | 'deferred' | 'accepted' = 'silent';
  const sent: AdapterSessionConfig[] = [];
  const adapter = daemon.registry.get('codex')!;
  adapter.createSession = async config => {
    sent.push(config);
    return { nativeSessionId: 'mode-fixture', onEvent: listener => { emit = listener; return () => { emit = undefined; }; },
      sendTurn: async ({turnId}) => { emit?.({type:'turn.started',turnId}); emit?.({type:'turn.completed',turnId}); },
      interrupt: async () => {}, dispose: async () => {}, resolveApproval: async () => {},
      updateConfig: async patch => {
        if (outcome === 'rejected') throw new Error('CLI rejected mode');
        if (outcome === 'deferred') throw Object.assign(new Error('new session required'), {code:'E_PENDING_NEXT_SESSION'});
        if (outcome === 'accepted') return {status:'applied' as const, confirmed:{permissionMode:patch.permissionMode}};
      } };
  };
  const ws = await daemon.sessionManager.addWorkspace(dataDir, 'mode path');
  const session = await daemon.sessionManager.createSession({workspaceId:ws.id,harnessId:'codex',permissionMode:'manual'});
  const open = async () => { await daemon.sessionManager.sendTurn(session.id,'config fixture'); await expect.poll(()=>daemon.store.getSession(session.id)?.status).toBe('idle'); };
  const receipt = async () => { const r = await daemon.sessionManager.getRequestBroker(session.id).service.getMode({sessionId:session.id}); return r.ok ? r.value : null; };
  await open(); expect(sent[0]?.permissionMode).toBe('manual'); expect((await receipt())?.status).toBe('pending_next_session');
  await daemon.sessionManager.updateSession(session.id,{permissionMode:'auto'});
  expect((await receipt())?.status).toBe('pending_next_session');
  outcome='rejected'; await daemon.sessionManager.updateSession(session.id,{permissionMode:'accept_edits'});
  expect((await receipt())?.status).toBe('rejected'); expect((await receipt())?.driverAccepted).toBeUndefined();
  outcome='deferred'; await daemon.sessionManager.updateSession(session.id,{permissionMode:'plan'});
  expect((await receipt())?.status).toBe('pending_next_session');
  outcome='accepted'; await open(); await daemon.sessionManager.updateSession(session.id,{permissionMode:'auto'});
  expect((await receipt())?.status).toBe('applied'); expect((await receipt())?.driverAccepted?.permissionMode).toBe('auto');
});

it('installs and binds external public-SDK policy instances and request view through real product APIs', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b4w2-product-'));
  const daemon = createDaemon({ dataDir, port: 0, webDistDir: null, bundledPluginsDir: path.join(root,'plugins/bundled') });
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true })); cleanup.push(() => daemon.stop());
  await daemon.start();
  for (const name of ['request-policy-lite','request-view-lite']) {
    const dirPath = path.join(root, 'plugins/examples/hm.plugin.' + name);
    const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath });
    await daemon.pluginManager.installPlugin({ mode: 'local_dir', dirPath, trustCode: true, expectedDigest: preview.digest, expectedInstalledDigest: preview.installedDigest });

  }
  for (const [id, decision] of [['policy-a','allow'],['policy-b','deny']]) {
    const result = await daemon.app.inject({ method: 'PUT', url: '/api/v1/plugins/composition/instances', payload: { id, name: 'hm.plugin.request-policy-lite', config: { decision } } }); expect(result.statusCode, result.body).toBe(200);
  }
  await daemon.pluginManager.reloadAll();
  const broker = daemon.sessionManager.getRequestBroker();
  for (const [id, expected] of [['policy-a','allow'],['policy-b','deny']]) {
    const dir = fs.mkdtempSync(path.join(dataDir, id));
    const ws = await daemon.sessionManager.addWorkspace(dir, id);
    for (const [contract, instanceId] of [['approval.policy.v1',id],['runtime.requests.view.v1','hm.plugin.request-view-lite']]) {
      const bound = await daemon.app.inject({ method: 'PUT', url: `/api/v1/workspaces/${ws.id}/bindings`, payload: { contract, instanceId } }); expect(bound.statusCode, bound.body).toBe(200);
    }
    const result = await broker.evaluate({ sessionId: '', workspaceId: ws.id, mode: 'auto', kind: 'command_approval', source: 'cli', toolName: 'test', toolKind: 'shell', readOnly: false, supportedDecisions: ['allow_once','deny'] });
    expect(result.decision).toBe(expected); expect(result.policyInstanceId).toBe(id);
    expect(daemon.pluginManager.resolveServiceSelection('runtime.requests.view.v1', { workspaceId: ws.id }).instanceId).toBe('hm.plugin.request-view-lite');
  }
  const ws = await daemon.sessionManager.addWorkspace(fs.mkdtempSync(path.join(dataDir,'lifecycle-')), 'lifecycle');
  const session = await daemon.sessionManager.createSession({workspaceId:ws.id,harnessId:'agy',permissionMode:'manual'});
  const fact = broker.register({workspaceId:ws.id,approval:{id:'lifecycle',sessionId:session.id,nativeRequestId:'life',kind:'command_approval',toolName:'read',toolKind:'file_read',summary:'Read',input:{},riskLevel:'low',status:'pending',createdAt:Date.now(),supportedDecisions:['allow_once','deny']},
    origin:{providerInstanceId:'original-driver',driverGeneration:'g1',nativeRequestId:'life',turnId:null},deadlineAtMs:Date.now()+10000,idempotencyKey:'life'}, {deliver:async()=> 'acknowledged'});
  await delay(); await daemon.pluginManager.togglePlugin('hm.plugin.requests-view-default',false);
  expect(broker.get(fact.requestId)?.status).toBe('pending');
  await daemon.pluginManager.togglePlugin('hm.plugin.approval-center',false); await delay();
  expect(daemon.store.getApproval(fact.requestId)?.status).toBe('cancelled');
  expect(()=>daemon.sessionManager.getRequestBroker()).toThrow('未启用');

});

// A replaceable policy exercises the real broker, SQLite transactions and delivery callback.
describe('B4-W2 policy modes and independent lifecycle', () => {
  it('cancels in-flight requests when their policy revision changes during evaluation', async () => {
    let revision = 'policy-run-1';
    let listener!: () => void;
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const policy = { evaluateRequest: async () => {
      started = true;
      await gate;
      return { decision: 'allow', scope: 'once' };
    } };
    const pm = { resolveCapabilityBinding: () => ({ instanceId: 'policy' }), host: {
      onServicesChanged: (fn: () => void) => { listener = fn; return () => {}; },
      getServiceByInstance: () => policy,
      listServiceProviders: () => [{ instanceId: 'policy', runId: revision }],
    } } as unknown as PluginManager;
    const { register, broker } = fixture(pm);
    const sent: string[] = [];
    register('policy-revision', async input => { sent.push(input.decision); return 'acknowledged'; });
    await expect.poll(() => started).toBe(true);
    expect(broker.get('policy-revision')?.policyRevision).toBe('policy-run-1');
    revision = 'policy-run-2'; listener(); release();
    await delay();
    expect(broker.get('policy-revision')?.status).toBe('cancelled');
    expect(sent).toEqual(['deny']);
  });
  it('does not apply an automatic decision evaluated before a concurrent risk annotation', async () => {
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const policy = { evaluateRequest: async () => {
      started = true;
      await gate;
      return { decision: 'allow', scope: 'once' };
    } };
    const pm = { resolveCapabilityBinding: () => ({ instanceId: 'policy' }), host: {
      onServicesChanged: () => () => {}, getServiceByInstance: () => policy,
      listServiceProviders: () => [{ instanceId: 'policy', runId: 'policy-run' }],
    } } as unknown as PluginManager;
    const { register, broker } = fixture(pm);
    let writes = 0;
    register('policy-race', async () => { writes++; return 'acknowledged'; });
    await expect.poll(() => started).toBe(true);
    broker.addAnnotation('policy-race', 'annotator', { label: 'Late risk', risk: 'high' });
    release();
    await delay();
    expect(broker.get('policy-race')?.status).toBe('pending');
    expect(writes).toBe(0);
  });
  it('runs legacy SDK risk annotators inside the request plugin before automatic policy decisions', async () => {
    let policy: any;
    const {apply}=await import('../../../plugins/bundled/hm.plugin.approval-policy-default/index.mjs');
    apply({provide:(_contract:string,service:unknown)=>{policy=service;}});
    const pm={resolveCapabilityBinding:()=>({instanceId:'policy'}),permissions:{isGranted:()=>true},listInstalled:()=>[{id:'annotator',instanceId:'annotator'}],
      isolated:{getActive:(id:string)=>id==='annotator'?{hasApprovalAnnotate:true,pluginId:'annotator',runId:'anno-run',process:{alive:true,
        call:async()=>({annotations:[{label:'External risk',risk:'high'}]})}}:undefined},
      host:{onServicesChanged:()=>()=>{},getServiceByInstance:()=>policy,listServiceProviders:()=>[{instanceId:'policy',runId:'policy-run'}]}} as unknown as PluginManager;
    const {register,broker,store}=fixture(pm);store.updateSession('s',{permissionMode:'auto'});let writes=0;
    register('annotated',async()=>{writes++;return 'acknowledged';});
    await delay(30);expect(writes).toBe(0);expect(broker.get('annotated')?.status).toBe('pending');
    expect(broker.get('annotated')?.approval.riskLevel).toBe('high');
    expect(broker.get('annotated')?.approval.annotations).toEqual(expect.arrayContaining([expect.objectContaining({pluginId:'annotator',label:'External risk'})]));
  });
  async function policyEnv(mode: string) {
    let service: any;
    const { apply } = await import('../../../plugins/bundled/hm.plugin.approval-policy-default/index.mjs');
    apply({ provide: (_name: string, value: unknown) => { service = value; } });
    let alive = true; let listener: (() => void) | undefined;
    const pm = { resolveCapabilityBinding: () => ({ instanceId: 'policy-instance' }), host: {
      getServiceByInstance: () => alive ? service : undefined,
      listServiceProviders: () => alive ? [{ instanceId: 'policy-instance', version: 'test-revision-2' }] : [],
      onServicesChanged: (fn: () => void) => { listener = fn; return () => { listener = undefined; }; },
    } } as unknown as PluginManager;
    const env = fixture(pm); env.store.updateSession('s', { permissionMode: mode as any });
    return { ...env, disable: () => { alive = false; listener?.(); } };
  }
  it.each([
    ['manual','command_approval','pending'], ['auto','command_approval','approved'],
    ['accept_edits','file_change_approval','approved'], ['accept_edits','command_approval','pending'],
    ['plan','command_approval','denied'], ['plan','user_question','pending'], ['auto','secret_request','pending'],
  ])('%s / %s commits the selected policy result %s', async (mode, kind, status) => {
    const { register, broker } = await policyEnv(mode); let writes = 0;
    register('mode', async () => { writes++; return 'acknowledged'; }, undefined, kind);
    await delay(); expect(broker.get('mode')?.status).toBe(status);
    expect(writes).toBe(status === 'pending' ? 0 : 1);
    expect(broker.get('mode')?.policyRevision).toBe('test-revision-2');
  });
  it('stops only the pinned policy requests and retains truthful driver receipts', async () => {
    const { register, broker, disable, store } = await policyEnv('manual');
    register('stop'); await delay(); disable(); await delay();
    expect(broker.get('stop')?.status).toBe('cancelled'); expect(store.getSession('s')?.pendingApprovalCount).toBe(0);
    for (const status of ['applied','pending_next_session','unsupported','rejected','policy_handled'] as const) {
      await broker.service.recordMode({ sessionId:'s', requested:'auto', policyInstanceId:'policy-instance', policyRevision:'r2', status,
        execution: status === 'policy_handled' ? 'per_request_policy' : status === 'applied' ? 'driver' : 'none',
        driverRequested:{permissionMode:'auto'}, driverAccepted:status === 'policy_handled' ? {modeId:'default'} : undefined });
      const receipt = await broker.service.getMode({sessionId:'s'}); expect(receipt.ok && receipt.value?.status).toBe(status);
    }
  });
});
