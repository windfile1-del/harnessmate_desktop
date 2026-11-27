export function apply(ctx) {
  let writes = Promise.resolve();
  const key = sessionId => `view:${sessionId}`;
  function mutate(sessionId, reducer, sourceId) {
    const operation = writes.then(async () => {
      const previous = await ctx.storage.plugin.get(key(sessionId)) ?? {};
      const state = {...reducer(previous), revision:(previous.revision??0)+1};
      await ctx.storage.plugin.set(key(sessionId), state);
      ctx.services.publish('chat.view.v1',{sessionId,state,sourceId});
      return {ok:true,value:{state}};
    });
    writes=operation.then(()=>{},()=>{});
    return operation;
  }
  ctx.provide('chat.view.v1', {
    async readViewState({sessionId}) { await writes; return {ok:true,value:{state:await ctx.storage.plugin.get(key(sessionId)) ?? {}}}; },
    writeViewState({sessionId,patch,sourceId}) { return mutate(sessionId, state=>({...state,...patch}),sourceId); },
    editViewState({sessionId,operation:op,sourceId}) {
      return mutate(sessionId,state=>{
        switch(op.type){
          case 'setText': return {...state,text:op.text};
          case 'clear': return {...state,text:'',attachments:[],terminalContexts:[]};
          case 'addAttachment': return {...state,attachments:[...(state.attachments??[]).filter(a=>a.id!==op.attachment.id),op.attachment]};
          case 'removeAttachment': return {...state,attachments:(state.attachments??[]).filter(a=>a.id!==op.id)};
          case 'addTerminalContext': return {...state,terminalContexts:[...(state.terminalContexts??[]).filter(a=>a.id!==op.chip.id),op.chip]};
          case 'removeTerminalContext': return {...state,terminalContexts:(state.terminalContexts??[]).filter(a=>a.id!==op.id)};
          case 'clearTerminalContexts': return {...state,terminalContexts:[]};
          default: throw new Error('未知视图状态操作');
        }
      },sourceId);
    }
  }, {version:'1.0.0'});
}
