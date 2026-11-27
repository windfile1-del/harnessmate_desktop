import { createRequire } from 'node:module';
const WS=createRequire(new URL('../../packages/daemon/package.json',import.meta.url))('ws');
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function targets(port){return fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());}
export async function connect(target){
 const ws=new WS(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
 let seq=0;const pending=new Map(),listeners=new Set();
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(new Error(JSON.stringify(m.error))):p?.resolve(m.result)}else for(const listener of listeners)listener(m)});
 ws.on('close',()=>{for(const request of pending.values())request.reject(new Error('CDP target closed'));pending.clear();});
 return {target,ws,listeners,call:(method,params={})=>new Promise((resolve,reject)=>{if(ws.readyState!==WS.OPEN){reject(new Error('CDP target closed'));return;}const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))}),async eval(expression){const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;},close(){ws.close();}};
}
