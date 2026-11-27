const hm=window.harnessMate;
const status=document.querySelector('#status');
const history=document.querySelector('#history');
const draft=document.querySelector('#draft');
let session=null, epoch=0, release, cursor=0, provider, syncing, loading=false, pending=new Map(), writes=Promise.resolve(),stream='';
const call=async(contract,method,args,options={})=>{
 const response=await hm.services.call(contract,method,args,{sessionId:session?.id,workspaceId:session?.workspaceId,...options});
 const result=response.value;
 if(!result.ok)throw new Error(result.error?.message||'服务调用失败');
 return result.value;
};
const report=error=>{status.textContent=String(error.message||error)};
const append=events=>{
 for(const event of events)if(event.sessionId===session.id&&event.seq>cursor)pending.set(event.seq,event);
 const fragment=document.createDocumentFragment();
 while(pending.has(cursor+1)){
  const event=pending.get(++cursor);pending.delete(cursor);
  if(event.type==='message.assistant.delta'||event.type==='message.assistant.reasoning.delta') fragment.append(document.createTextNode(String(event.payload.text||event.payload.delta||'')));
  else {const row=document.createElement('div');row.textContent=`[${event.seq}] ${event.type} ${JSON.stringify(event.payload)}`;fragment.append(row);}
 }
 history.append(fragment); history.scrollTop=history.scrollHeight;
};
async function sync(){
 if(syncing)return syncing;
 const generation=epoch,id=session.id;
 return syncing=(async()=>{
  const info=await call('session.data.v1','getStreamInfo',[],{instanceId:provider});
  if(generation!==epoch)return;
  const identity=JSON.stringify(info.stream);
  if(stream&&stream!==identity){cursor=0;pending.clear();history.replaceChildren();}
  stream=identity;
  const detail=await call('session.data.v1','getSession',[{sessionId:id}],{instanceId:provider});
  const boundary=detail.session.lastSeq;
  let afterSeq=cursor;
  while(afterSeq<boundary&&generation===epoch){
   const page=await call('session.data.v1','listEvents',[{sessionId:id,afterSeq,throughSeq:boundary,limit:1000}],{instanceId:provider});
   if(generation!==epoch)return;
   if(!page.events.length)throw new Error('历史事件存在间隙');
   afterSeq=page.events.at(-1).seq;append(page.events);
  }
  if(generation===epoch)status.textContent=`已同步 · ${cursor}`;
 })().finally(()=>{syncing=null});
}
async function activate(next){
 const generation=++epoch;release?.();release=null;session=next;cursor=0;stream='';syncing=null;pending.clear();history.replaceChildren();
 if(!session){status.textContent='选择会话';return;}
 try{
  const own=await call('chat.view.v1','readViewState',[{sessionId:session.id}],{instanceId:hm.instanceId});
  if(generation!==epoch)return;draft.value=own.state?.text||'';
  const selection=await hm.resolveService({contract:'session.data.v1',sessionId:session.id,workspaceId:session.workspaceId});
  if(selection.status!=='ready')throw new Error(selection.status);provider=selection.instanceId;
  loading=true;let buffered=[];let initial=true;
  const off=await hm.services.subscribe({contract:'session.data.v1',instanceId:provider},batch=>{
   if(generation!==epoch)return;
   if(batch.reset){if(initial){initial=false;return;}void sync().catch(report);return;}
   const events=batch.events.flatMap(entry=>entry.payload.sessionId===session.id?entry.payload.events||[]:[]);
   if(loading){if(buffered.length<10000)buffered.push(...events);}else{append(events);if(pending.size)void sync().catch(report);}
  });
  if(generation!==epoch){off();return;}release=off;
  await sync();if(generation!==epoch)return;loading=false;append(buffered);buffered=[];if(pending.size)await sync();
 }catch(error){report(error);}
}
draft.oninput=()=>{const id=session?.id,text=draft.value;if(!id)return;writes=writes.then(()=>call('chat.view.v1','writeViewState',[{sessionId:id,patch:{text}}],{instanceId:hm.instanceId})).catch(report)};
document.querySelector('#send').onclick=async()=>{
 if(!session||!draft.value.trim())return;
 const id=session.id,text=draft.value;
 try{await call('session.runtime.v1','sendTurn',[{sessionId:id,text,requestId:crypto.randomUUID()}]);if(session?.id===id&&draft.value===text){draft.value='';draft.oninput();}}catch(error){report(error)}
};
document.querySelector('#interrupt').onclick=()=>call('session.runtime.v1','interrupt',[{sessionId:session.id}]).catch(report);
document.querySelector('#restore').onclick=()=>sync().catch(report);
document.querySelector('#file').onclick=()=>{const raw=document.querySelector('#path').value,match=/^(.*?)(?::(\d+))?$/.exec(raw);hm.navigateToFile({sessionId:session?.id,path:match[1],line:match[2]?Number(match[2]):undefined}).catch(report)};
hm.onContext(next=>{if(next?.id!==session?.id)void activate(next)});
void activate(hm.session);
