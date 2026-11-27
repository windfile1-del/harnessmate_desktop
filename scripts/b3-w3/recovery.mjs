import fs from 'node:fs';
import {targets,connect,sleep} from './cdp.mjs';
const [apiPort='49771',debugPort='49772']=process.argv.slice(2);
const base=`http://127.0.0.1:${apiPort}`;
async function api(route,body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw new Error(`${r.status} ${JSON.stringify(j)}`);return j;}
const shell=await connect((await targets(debugPort)).find(t=>t.type==='page'));
const before=(await api('/api/v1/sessions')).sessions.map(s=>s.id);
await api('/api/v1/plugins/composition/restore',{source:'empty'});
const wait=async fn=>{for(let i=0;i<160;i++){try{const r=await fn();if(r)return r;}catch{}await sleep(250);}throw new Error('recovery timeout')};
await wait(()=>shell.eval('!!document.querySelector("main[aria-label=内核恢复模式]")'));
const empty={text:await shell.eval('document.body.innerText'),iframes:await shell.eval('document.querySelectorAll("iframe").length'),plugins:(await api('/api/v1/plugins')).plugins.filter(p=>p.enabled).map(p=>p.instanceId||p.id)};
const image=await shell.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync('.tmp/w3/recovery-empty.png',Buffer.from(image.data,'base64'));
await shell.eval('(()=>{const e=[...document.querySelectorAll("button")].find(e=>e.innerText.includes("重新启用预装组合"));e.click();return true})()');
await wait(()=>shell.eval('!document.querySelector("main[aria-label=内核恢复模式]") && document.querySelectorAll("iframe").length>0'));
const after=(await api('/api/v1/sessions')).sessions.map(s=>s.id);
if(JSON.stringify([...before].sort())!==JSON.stringify([...after].sort()))throw new Error('Recovery created or removed sessions');
fs.writeFileSync('.tmp/w3/recovery-results.json',JSON.stringify({empty,before,after,recovered:true},null,2));
console.log(JSON.stringify({emptyIframes:empty.iframes,enabled:empty.plugins.length,sessions:after.length,recovered:true}));
shell.close();
