// Synthetic ACP peer. Exercises the real AGY driver and stdio path; never contacts an account.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const output = process.argv[2];
const log = (direction, message) => fs.appendFileSync(path.join(output, 'agy-wire.ndjson'), JSON.stringify({ direction, message }) + '\n');
const send = message => { log('peer_to_driver', message); process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...message}) + '\n'); };
let promptId;
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const msg = JSON.parse(line); log('driver_to_peer', msg);
  if (msg.method === 'initialize') send({id:msg.id,result:{protocolVersion:1,agentInfo:{name:'b4-w2-synthetic-peer',version:'1'},agentCapabilities:{promptCapabilities:{embeddedContext:false}}}});
  else if (msg.method === 'session/new') send({id:msg.id,result:{sessionId:'b4-w2-native',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]},configOptions:[]}});
  else if (msg.method === 'session/set_mode') send({id:msg.id,result:{}});
  else if (msg.method === 'session/prompt') {
    promptId=msg.id;
    send({id:8101,method:'session/request_permission',params:{sessionId:'b4-w2-native',toolCall:{toolCallId:'write-fixture',kind:'execute',title:'AGY browser permission',rawInput:{command:'write fixture result inside isolated test directory'}},
      options:[{optionId:'allow_once',kind:'allow_once',name:'Allow fixture once'},{optionId:'reject_once',kind:'reject_once',name:'Reject fixture'}]}});
  } else if (msg.id === 8101 && !msg.method) {
    if (msg.result?.outcome?.optionId === 'allow_once') fs.writeFileSync(path.join(output,'agy.tool-result'),'executed only after native permission response');
    send({id:promptId,result:{stopReason:'end_turn'}});
  }
});
