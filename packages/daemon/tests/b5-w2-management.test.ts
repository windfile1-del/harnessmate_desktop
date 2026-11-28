import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';
import { loadOrCreateConfig, saveConfig } from '../src/config.js';
import { generateDeveloper, developerBase } from './helpers/developer-tools.js';
import type { NormalizedAdapterEvent } from '../src/harnesses/types.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const active: DaemonInstance[] = []; const dirs: string[] = [];
afterEach(async () => { for (const d of active.splice(0)) await d.stop(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function temp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-w2-')); dirs.push(d); return d; }
async function start(dataDir = temp()) { const d = createDaemon({ dataDir, port: 0, webDistDir: null }); active.push(d); await d.start(); return d; }
function readExample(name: string) { const base = path.join(root, 'plugins/examples', name); return Object.fromEntries(['harnessmate-plugin.json', 'index.mjs', 'ui/index.html'].map(p => [p, fs.readFileSync(path.join(base,p), 'utf8')])); }
async function settle(fn: () => Promise<boolean>) { for (let i=0;i<100;i++) { if(await fn()) return; await new Promise(r=>setTimeout(r,30)); } throw Error('Condition did not settle'); }
it('B5-A3 migrates B4 owner fields idempotently and preserves account IDs/bindings and B4 mirrors', () => {
  const file = path.join(temp(), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ binaryOverrides: { codex: 'D:/cli/codex.exe' }, harnessInstances: [{ instanceId: 'work', driverId: 'codex', displayName: 'Work', enabled: true }], customAcpHarnesses: [], agyProfiles: [{ instanceId: 'agy-work', label: 'Work' }] }));
  const config = loadOrCreateConfig(file); expect(config.pluginConfig?.['harness-codex']?.binaryPath).toBe('D:/cli/codex.exe');
  expect(config.harnessInstances[0]?.instanceId).toBe('work');
  config.pluginConfig!['harness-agy'] = { profiles: [{ instanceId: 'agy-next', label: 'Next' }] };
  expect(config.agyProfiles[0]?.instanceId).toBe('agy-next'); saveConfig(file,config);
  expect(loadOrCreateConfig(file).agyProfiles[0]?.instanceId).toBe('agy-next');
  expect(JSON.parse(fs.readFileSync(file,'utf8')).harnessInstances[0].instanceId).toBe('work');
  config.pluginConfig!['third-party'] = { instances: [{ id: 'keep-me' }] };
  config.harnessInstances = config.harnessInstances; expect(config.pluginConfig!['third-party'].instances).toEqual([{ id: 'keep-me' }]);
  expect(config.harnessInstances).toHaveLength(1);
  config.binaryOverrides = {}; expect(config.pluginConfig!['harness-codex'].binaryPath).toBeUndefined();
});
it('B5-A3/A8 external manager installs, binds, self-disables; kernel can restore it without any management provider', async () => {
  const d = await start(); const call = (url: string, payload?: unknown, method = payload === undefined ? 'GET' : 'POST') => d.app.inject({ method: method as 'GET' | 'POST', url, payload });
  const source = path.join(root,'plugins/examples/hm.plugin.management-lite');
  const review = (await call('/api/v1/plugins/preview',{ mode:'local_dir',dirPath:source })).json();
  const install = await call('/api/v1/plugins/install',{ mode:'local_dir',dirPath:source,expectedDigest:review.digest,trustCode:true });
  expect(install.statusCode,install.body).toBe(201);
  expect((await call('/api/v1/plugins/composition/bindings',{contract:'management.view.v1',instanceId:'user.management-lite'},'PUT')).statusCode).toBe(200);
  expect(d.pluginManager.resolveServiceSelection('management.view.v1',{allowSingleCandidate:false}).status).toBe('ready');
  expect((await call('/api/v1/plugins/user.management-lite',{enabled:false},'PATCH')).statusCode).toBe(200);
  await call('/api/v1/plugins/hm.plugin.management-default',{enabled:false},'PATCH');
  expect(d.pluginManager.resolveServiceSelection('management.view.v1',{allowSingleCandidate:false}).status).toBe('disabled');
  expect((await call('/api/v1/plugins')).json().plugins.some((p: {id:string})=>p.id==='user.management-lite')).toBe(true);
  expect((await call('/api/v1/plugins/user.management-lite',{enabled:true},'PATCH')).statusCode).toBe(200);
  expect(d.pluginManager.resolveServiceSelection('management.view.v1',{allowSingleCandidate:false}).status).toBe('ready');
  // A good external self-update establishes an actual previous revision. A bad next
  // apply must preserve both current provider and independent kernel controls.
  const updateDir = path.join(temp(), 'external'); fs.cpSync(source, updateDir, { recursive: true });
  const manifestFile = path.join(updateDir, 'harnessmate-plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); manifest.version = '1.0.1'; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  let reviewed = (await call('/api/v1/plugins/preview', { mode:'local_dir', dirPath:updateDir })).json();
  expect((await call('/api/v1/plugins/install', { mode:'local_dir',dirPath:updateDir,expectedDigest:reviewed.digest,expectedInstalledDigest:reviewed.installedDigest,trustCode:true })).statusCode).toBe(201);
  manifest.version = '1.0.2'; fs.writeFileSync(manifestFile, JSON.stringify(manifest)); fs.writeFileSync(path.join(updateDir,'index.mjs'),'export function apply() { throw new Error("broken self update"); }');
  reviewed = (await call('/api/v1/plugins/preview', { mode:'local_dir', dirPath:updateDir })).json();
  expect((await call('/api/v1/plugins/install', {mode:'local_dir',dirPath:updateDir,expectedDigest:reviewed.digest,expectedInstalledDigest:reviewed.installedDigest,trustCode:true})).statusCode).toBeGreaterThanOrEqual(400);
  expect(d.pluginManager.listInstalled().find(p=>p.id==='user.management-lite')?.version).toBe('1.0.1');
  expect((await call('/api/v1/plugins/user.management-lite/rollback',{})).statusCode).toBe(200);
  expect(d.pluginManager.listInstalled().find(p=>p.id==='user.management-lite')?.version).toBe('1.0.0');
  await call('/api/v1/plugins/composition/bindings',{contract:'management.view.v1',instanceId:null},'PUT');
  expect((await call('/api/v1/plugins/composition/restore',{source:'previous'})).statusCode).toBe(200);
  expect(d.pluginManager.getComposition().bindings['management.view.v1']).toBe('user.management-lite');
  const settings = await call('/api/v1/plugins/harness-codex/settings'); expect(settings.statusCode).toBe(200);
  const before = d.pluginManager.getComposition().bindings;
  const saved = await call('/api/v1/plugins/harness-codex/settings',{ config:{binaryPath:'D:/cli/test-codex.exe',instances:[]},schemaVersion:1,expectedVersion:'1.0.0'},'PUT');
  expect(saved.statusCode,saved.body).toBe(200); expect(saved.json().settings.config.binaryPath).toBe('D:/cli/test-codex.exe'); expect(d.pluginManager.getComposition().bindings).toEqual(before);
});
it('B5-A4 generates real page/service files, diagnoses, installs dev revision, previews, hot-reloads and rejects bad revision', {timeout:30000}, async () => {
  const d=await start(); const workspace=await d.sessionManager.addWorkspace(temp()); const files=readExample('user.release-notebook'); const manifest=JSON.parse(files['harnessmate-plugin.json']!);
  let calls=0;
  d.registry.get('codex')!.createSession=async()=>{let cb:((event:NormalizedAdapterEvent)=>void)|undefined;return {nativeSessionId:null,onEvent(fn){cb=fn;return()=>{cb=undefined;}},async sendTurn({turnId}) { calls++;cb?.({type:'message.assistant.completed',turnId,text:JSON.stringify({manifest,files})});cb?.({type:'turn.completed',turnId}); },async interrupt(){},async resolveApproval(){},async dispose(){} };};
  const gen=await generateDeveloper(d,{description:'创建发布便笺页面及 example.release-notebook.v1 服务',harnessId:'codex',workspaceId:workspace.id,tier:'tier2',template:'isolated'});
  expect(gen.statusCode,gen.body).toBe(200); const result=gen.json(); expect(result.verified,JSON.stringify(result.steps)).toBe(true); expect(calls).toBe(1);
  let response=await d.app.inject({method:'POST',url:developerBase+'/install',payload:{draftId:result.draftId,expectedDigest:result.digest,installMode:'dev_link',trustCode:true}});
  expect(response.statusCode,response.body).toBe(201); const installed=response.json(); expect(installed.activation.previewPages).toContainEqual({instanceId:manifest.id,pageId:'notes'});
  response=await d.app.inject({method:'POST',url:developerBase+'/install',payload:{draftId:result.draftId,expectedDigest:result.digest,installMode:'dev_link',trustCode:false}});
  expect(response.statusCode,response.body).toBe(201); // same source keeps its existing trust
  await d.pluginManager.setCompositionBinding('example.release-notebook.v1',manifest.id);
  const info=d.pluginManager.listInstalled().find(p=>p.id===manifest.id)!;
  const granted=await d.app.inject({method:'PUT',url:'/api/v1/plugins/'+manifest.id+'/permissions',payload:{workspaceId:'__global__',digest:info.packageDigest,capability:'storage:plugin',granted:true,coverFuture:true}}); expect(granted.statusCode,granted.body).toBe(200);
  const value=await d.pluginManager.invokeServiceSelection('example.release-notebook.v1','read',[],{allowSingleCandidate:false}); expect(value).toMatchObject({value:{text:''}});
  const page=await d.app.inject({url:'/api/v1/plugins/'+manifest.id+'/ui/ui/index.html'}); expect(page.statusCode,page.body).toBe(200); expect(page.body).toContain('发布便笺');
  const file=path.join(installed.dirPath,'index.mjs'); const source=fs.readFileSync(file,'utf8'); fs.writeFileSync(file,source.replace("version: '1.0.0'","version: '1.0.1'"));
  await d.pluginManager.reloadDevPlugin(manifest.id); expect(await d.pluginManager.invokeServiceSelection('example.release-notebook.v1','getInfo',[],{allowSingleCandidate:false})).toMatchObject({value:{version:'1.0.1'}});
  fs.writeFileSync(file,'export function apply() { throw new Error("bad revision"); }'); await expect(d.pluginManager.reloadDevPlugin(manifest.id)).rejects.toThrow();
  await new Promise(r=>setTimeout(r,700));
  await settle(async()=>d.pluginManager.resolveServiceSelection('example.release-notebook.v1',{allowSingleCandidate:false}).status==='ready');
  expect(await d.pluginManager.invokeServiceSelection('example.release-notebook.v1','getInfo',[],{allowSingleCandidate:false})).toMatchObject({value:{version:'1.0.1'}});
  fs.writeFileSync(file,source); await d.pluginManager.reloadDevPlugin(manifest.id);
  await d.pluginManager.rollbackPlugin(manifest.id); expect(d.pluginManager.listInstalled().find(p=>p.id===manifest.id)?.enabled).toBe(true);
  await d.pluginManager.togglePlugin(manifest.id,false); expect(d.pluginManager.resolveServiceSelection('example.release-notebook.v1',{allowSingleCandidate:false}).status).toBe('disabled');
});
it('B5-A4 cancellation, page-close retry, tool disposal and reconnect never duplicate or resume a cancelled task', {timeout:30000}, async () => {
  const d=await start(); const ws=await d.sessionManager.addWorkspace(temp());let disposed=0;
  d.registry.get('codex')!.createSession=async()=>({nativeSessionId:null,onEvent(){return()=>{};},async sendTurn(){await new Promise(r=>setTimeout(r,30));},async interrupt(){},async resolveApproval(){},async dispose(){disposed++;}});
  const input={taskId:'close-task',kind:'generate',closePolicy:'cancel',input:{description:'生成完整插件页面',harnessId:'codex',workspaceId:ws.id,tier:'tier2'}};
  let response=await d.app.inject({method:'POST',url:developerBase+'/tasks',payload:input});expect(response.statusCode,response.body).toBe(202);
  await settle(async()=>!!d.pluginManager.isolated);
  await new Promise(r=>setTimeout(r,100));
  response=await d.app.inject({method:'POST',url:developerBase+'/tasks/close-task/cancel',payload:{}});expect(response.json().task.status).toBe('cancelled');
  await settle(async()=>disposed>0);
  response=await d.app.inject({method:'POST',url:developerBase+'/tasks',payload:input});expect(response.json().task.status).toBe('cancelled');
  await d.app.inject({method:'POST',url:developerBase+'/tasks',payload:{...input,taskId:'shutdown-task',closePolicy:'background'}});
  await d.pluginManager.togglePlugin('hm.plugin.developer-tools',false);
  expect((await d.app.inject({url:developerBase+'/tasks'})).statusCode).toBeGreaterThanOrEqual(400);
  await d.pluginManager.togglePlugin('hm.plugin.developer-tools',true);
  response=await d.app.inject({url:developerBase+'/tasks'});expect(response.statusCode,response.body).toBe(200);expect(response.json().tasks.find((t:{taskId:string})=>t.taskId==='shutdown-task').status).toBe('cancelled');
  const context=(await d.app.inject({url:developerBase+'/context'})).json();expect(context.sdkVersion).toBeTruthy();expect(context.userMessage).toContain('SDK');
  expect((await d.app.inject({method:'POST',url:'/api/v1/plugins/builder-v2/generate',payload:{}})).statusCode).toBe(404);
  await d.app.inject({method:'POST',url:developerBase+'/tasks',payload:{...input,taskId:'process-restart-task',closePolicy:'background'}});
  const dataDir = d.paths.dataDir; active.splice(active.indexOf(d),1); await d.stop();
  const restarted = await start(dataDir);
  const journal = (await restarted.app.inject({url:developerBase+'/tasks'})).json().tasks;
  expect(journal.find((t:{taskId:string})=>t.taskId==='process-restart-task').status).toBe('cancelled');
  expect((await restarted.app.inject({url:'/api/v1/plugins'})).statusCode).toBe(200);
});
