import fs from 'node:fs';
import path from 'node:path';
const port=process.argv[2]||49371;
const root=path.resolve('.');
const base=`http://127.0.0.1:${port}`;
for(let attempt=0;;attempt++){
 try { const response=await fetch(base+'/api/v1/health'); if(response.ok)break; } catch {}
 if(attempt>=240)throw new Error('Daemon startup did not complete');
 await new Promise(resolve=>setTimeout(resolve,250));
}
async function api(route,body,method=body?'POST':'GET'){
 const r=await fetch(base+route,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 const result=await r.json();if(!r.ok)throw new Error(`${route} ${r.status} ${JSON.stringify(result).slice(0,800)}`);return result;
}
const dirPath=path.join(root,'plugins/examples/hm.plugin.fixed-replay');
const p=await api('/api/v1/plugins/preview',{mode:'local_dir',dirPath});
console.log('preview',p.manifest.id,p.digest);
await api('/api/v1/plugins/install',{mode:'local_dir',dirPath,trustCode:true,expectedDigest:p.digest,expectedInstalledDigest:p.installedDigest});
for(const capability of p.manifest.permissions)await api(`/api/v1/plugins/${p.manifest.id}/permissions`,{workspaceId:'__global__',digest:p.digest,capability,granted:true},'PUT');
await api(`/api/v1/plugins/${p.manifest.id}`,{enabled:true},'PATCH');
const {harnesses}=await api('/api/v1/harnesses');console.log('drivers',harnesses.map(h=>({id:h.id,kind:h.kind,driver:h.driverId,health:h.health})));
const h=harnesses.find(h=>h.id.includes('fixed-replay'));
if(!h)throw new Error('driver absent');
const repo=path.resolve(process.env.HARNESSMATE_REPLAY_WORKSPACE||path.join(root,'.tmp/w3/replay-workspace'));fs.mkdirSync(repo,{recursive:true});fs.writeFileSync(path.join(repo,'README.md'),'# Replay navigation\n第二行\n');
const existing=(await api('/api/v1/workspaces')).workspaces;
const workspace=existing.find(w=>w.rootPath===repo)||(await api('/api/v1/workspaces',{rootPath:repo,name:'Replay W3'})).workspace;
const {session}=await api('/api/v1/sessions',{workspaceId:workspace.id,harnessId:h.id,title:'W3 replay acceptance',model:'replay',permissionMode:'manual'});
console.log('created',session.id,workspace.id,h.id);
fs.writeFileSync(`.tmp/w3/setup-${port}.json`,JSON.stringify({session,workspace,harness:h},null,2));
