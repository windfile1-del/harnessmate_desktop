import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeRequestDto } from '@harnessmate/plugin-api';
import { RequestQueue, visibleRequests } from '../src/plugins/requests-view-default/main';
import { useRequestViewStore } from '../src/plugins/requests-view-default/store';
vi.mock('../src/plugins/requests-view-default/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/plugins/requests-view-default/store')>();
  const bound = original.useRequestViewStore;
  return { ...original, useRequestViewStore: Object.assign(() => bound.getState(), bound) };
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fact = (status: string, closed = false): RuntimeRequestDto => ({ requestId:'stable-id',sessionId:'s',workspaceId:'w',
  origin:{providerInstanceId:'driver',driverGeneration:'g1',nativeRequestId:1,turnId:'t'},version:2,idempotencyKey:'k',
  status,closed,delivery:'acknowledged',deadlineAtMs:1,approval:{id:'stable-id',sessionId:'s',summary:'Old request',kind:'command_approval',toolName:'tool',status} });
afterEach(()=>useRequestViewStore.setState({requests:[],mode:null,error:null,session:null}));
describe('B4-W2 request view lifecycle',()=>{
  it('removes expired/ended cards from pending and offers persistent-ID close in history',()=>{
    useRequestViewStore.setState({requests:[fact('expired')]});
    const pending=renderToStaticMarkup(<RequestQueue/>);
    expect(pending).toContain('待处理 (0)'); expect(pending).not.toContain('data-request-id="stable-id"');
    const history=renderToStaticMarkup(<RequestQueue initialHistory/>);
    expect(history).toContain('关闭 stable-id'); expect(history).toContain('expired');
    useRequestViewStore.setState({requests:[fact('expired',true)]});
    expect(renderToStaticMarkup(<RequestQueue initialHistory/>)).not.toContain('data-request-id="stable-id"');
    expect(visibleRequests([fact('cancelled')])).toHaveLength(0);
    expect(visibleRequests([fact('expired',true)],true)).toHaveLength(0);
  });
  it('renders driver acceptance separately from saved mode and has no host or AGY alternate approval implementation',()=>{
    useRequestViewStore.setState({mode:{sessionId:'s',requested:'auto',policyInstanceId:'p',policyRevision:'r',status:'policy_handled',execution:'per_request_policy',driverAccepted:{modeId:'default'}}});
    const html=renderToStaticMarkup(<RequestQueue/>); expect(html).toContain('policy_handled'); expect(html).toContain('per_request_policy'); expect(html).toContain('default');
    const chat=fs.readFileSync(path.join(root,'packages/web/src/plugins/chat-default/ChatStage.tsx'),'utf8');
    expect(chat).not.toContain("from '../../components/ApprovalCenter'"); expect(chat).toContain('runtime.requests.view.v1');
    const agyCard=fs.readFileSync(path.join(root,'packages/web/src/components/agy/native/shared/NativeRequestCard.tsx'),'utf8');
    expect(agyCard).not.toContain('handleDecision'); expect(agyCard).not.toContain('onResolve(');
    expect(fs.readFileSync(path.join(root,'packages/web/vite.agy.config.ts'),'utf8')).toContain('/plugins/requests-view-default/');
  });
});
