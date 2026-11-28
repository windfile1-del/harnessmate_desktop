import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { KernelRecoveryView } from '../src/components/KernelRecoveryView';
import { kernelRecoveryClient } from '../src/kernel/recovery-client';
import { daemonApi, withPluginDevelopmentContext } from '../src/api/client';
import { openContractPage } from '../src/api/plugin-navigation';
import { ManagementApp } from '../src/plugins/management/App';
import type { TrustedModulePageBridge } from '../src/slots/TrustedPluginModuleHost';
import { withManagement } from './helpers/management';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('public capability navigation uses the selected external instance and its declared page', async()=>{
  vi.spyOn(daemonApi,'resolveServiceSelection').mockResolvedValue({status:'ready',instanceId:'external.manager'} as never);
  vi.spyOn(daemonApi,'listPlugins').mockResolvedValue({plugins:[{id:'vendor.manager',instanceId:'external.manager',contributes:{slots:[{slot:'workspace.pages',id:'custom-management'}]}}]} as never);
  const navigate=vi.fn(async()=>({requestId:'nav',status:'accepted'} as const));
  await openContractPage('management.view.v1',undefined,{managementTab:'settings'},navigate);
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({target:expect.objectContaining({instanceId:'external.manager',pageId:'custom-management'}),context:{managementTab:'settings'}}));
  vi.mocked(daemonApi.resolveServiceSelection).mockResolvedValue({status:'disabled',instanceId:'external.manager'} as never);
  expect((await openContractPage('management.view.v1',undefined,undefined,navigate)).status).toBe('unavailable'); expect(navigate).toHaveBeenCalledTimes(1);
});
it('developer context is added to a single user message only in development mode',async()=>{
  const fetcher=vi.fn(async(url:unknown)=>new Response(JSON.stringify(String(url).includes('/resolve')?{status:'ready',instanceId:'external.dev'}:{userMessage:'SDK 4.0; install/deactivate/reload'}),{status:200}));vi.stubGlobal('fetch',fetcher);
  expect(await withPluginDevelopmentContext('hello','normal')).toBe('hello');expect(fetcher).not.toHaveBeenCalled();
  expect(await withPluginDevelopmentContext('make a page','plugin_development')).toContain('SDK 4.0');
  expect(await withPluginDevelopmentContext('ordinary again','normal')).toBe('ordinary again');expect(fetcher).toHaveBeenCalledTimes(2);
});
it('kernel recovery previews and installs via the same public kernel API without management state',async()=>{
  const html=renderToStaticMarkup(<KernelRecoveryView/>);expect(html).toContain('恢复插件目录');expect(html).toContain('恢复绑定契约');
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({manifest:{name:'External'},digest:'a'.repeat(64),requiresTrust:true}),{status:200}));vi.stubGlobal('fetch',fetcher);
  await kernelRecoveryClient.previewInstall({mode:'local_dir',dirPath:'D:/plugins/ext'});await kernelRecoveryClient.install({mode:'local_dir',dirPath:'D:/plugins/ext',expectedDigest:'a'.repeat(64),trustCode:true});
  expect(fetcher.mock.calls.map(c=>String(c[0]))).toEqual(['/api/v1/plugins/preview','/api/v1/plugins/install']);
});
it('management UI mounts using instance state and build source has no private layout store',()=>{
  const bridge={instanceId:'external.manager',props:{},surfaces:{getRenderFailures:()=>[],onSlotsChanged:()=>()=>{}}} as unknown as TrustedModulePageBridge;
  const html=renderToStaticMarkup(withManagement(<ManagementApp bridge={bridge}/>));expect(html).toContain('external.manager');expect(html).toContain('实例与绑定');expect(html).toContain('设置');
  for(const dir of ['management','developer-tools']) for(const file of fs.readdirSync(path.resolve('src/plugins',dir))) if(/tsx?$/.test(file)) expect(fs.readFileSync(path.resolve('src/plugins',dir,file),'utf8')).not.toContain('stores/app-store');
});
it('page-close cancellation survives a late start acknowledgement while explicit background work is retained',async()=>{
  for (const [policy, reason, shouldCancel] of [['cancel','page_close',true],['background','page_close',false],['background','user_cancel',true]] as const) {
    let acknowledge: (()=>void) | undefined; const calls: string[]=[];
    const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{
      const name=String(url); calls.push(name);
      if(name.endsWith('/tasks')) { expect(init?.signal).toBeUndefined(); await new Promise<void>(resolve=>{acknowledge=resolve;}); }
      return new Response(JSON.stringify({task:{status:'cancelled'}}),{status:200});
    }); vi.stubGlobal('fetch',fetcher);
    const abort=new AbortController(); const pending=daemonApi.generatePluginV2({description:'make a page',workspaceId:'ws',harnessId:'fixture'} as never,abort.signal,'tool',policy).catch(e=>e);
    expect(acknowledge).toBeTypeOf('function'); abort.abort(reason); acknowledge!(); expect(await pending).toBe(reason);
    expect(calls.some(url=>url.endsWith('/cancel'))).toBe(shouldCancel);
    if(shouldCancel) expect(calls.filter(url=>url.endsWith('/cancel')).length).toBeGreaterThanOrEqual(2);
  }
});
