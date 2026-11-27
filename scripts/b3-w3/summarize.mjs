import fs from 'node:fs';import path from 'node:path';
const root=process.argv[2]||'D:/HarnessMate/b3-tmp/w3/performance';
const output=process.argv[3]||path.join(root,'summary.json');
const quantile=(values,q)=>{const a=values.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?a[Math.min(a.length-1,Math.ceil(a.length*q)-1)]:null};
function markers(value){return [...JSON.stringify(value).matchAll(/HMREPLAY_([0-9]+)_([0-9]+)/g)].map(m=>m[0]);}
function canonical(frame){return frame.op==='event'?[frame.event]:(frame.events||[]).flatMap(entry=>entry.payload?.events||[]);}
function first(map,key,value){if(!map.has(key)||value<map.get(key))map.set(key,value);}
const runs=[];
for(const version of ['B2','B3'])for(let run=1;run<=3;run++){
 const file=path.join(root,`${version.toLowerCase()}-${run}`,'raw.json');const d=JSON.parse(fs.readFileSync(file,'utf8'));
 const ws=new Map(),page=new Map(),created=new Map(),published=new Map();
 for(const sample of d.received)for(const event of canonical(sample.frame))if(event?.sessionId===d.session.id)for(const key of markers(event.payload))first(ws,key,sample.at);
 for(const sample of d.metrics.received)for(const event of canonical(sample.batch))if(event?.sessionId===d.session.id)for(const key of markers(event.payload))first(page,key,sample.at);
 for(const sample of d.received)for(const entry of sample.frame.events||[])for(const event of entry.payload?.events||[])if(event.sessionId===d.session.id)for(const key of markers(event.payload))first(published,key,entry.emittedAt);
 for(const event of d.events)for(const key of markers(event.payload))first(created,key,event.createdAt);
 const visible=d.metrics.visible.filter(v=>v.index<1500);
 const updates=[...new Set(visible.map(v=>v.at))].sort((a,b)=>a-b),intervals=updates.slice(1).map((at,i)=>at-updates[i]);
 const latencies=visible.filter(v=>(version==='B3'?page:ws).has(v.key)).map(v=>v.at-(version==='B3'?page:ws).get(v.key));
 const emit=visible.map(v=>v.at-v.emitted),wsLatency=visible.filter(v=>ws.has(v.key)).map(v=>v.at-ws.get(v.key));
 const inputPause=Math.max(0,...intervals),emitP95=quantile(emit,.95),pageP95=quantile(latencies,.95);
 const serviceIds=new Set();let peakServiceSubscriptions=0;
 for(const entry of d.sent){if(entry.frame.op==='subscribe_service')serviceIds.add(entry.frame.subscriptionId);if(entry.frame.op==='unsubscribe_service')serviceIds.delete(entry.frame.subscriptionId);peakServiceSubscriptions=Math.max(peakServiceSubscriptions,serviceIds.size);}
 runs.push({version,run,file,historyEvents:d.fixture.historyEvents,fixtureBytes:d.fixture.historyBytes,fixtureDigest:d.fixture.digest,historyReadyMs:d.historyReadyMs,
   visibleMarkers:visible.length,matchedPageMarkers:latencies.length,firstSegmentProxyMs:visible[0]?visible[0].at-visible[0].emitted:null,
   pageReceiptToRenderedP95Ms:pageP95,wsToRenderedP95Ms:quantile(wsLatency,.95),driverEmitToRenderedP95Ms:emitP95,
   createdAtToRenderedP95Ms:quantile(visible.filter(v=>created.has(v.key)).map(v=>v.at-created.get(v.key)),.95),
   postCommitPublishToRenderedP95Ms:quantile(visible.filter(v=>published.has(v.key)).map(v=>v.at-published.get(v.key)),.95),
   updateIntervalP95Ms:quantile(intervals,.95),maxUpdateGapMs:inputPause,updatesPerSecond:updates.length/60,
   pageLongTasks:d.metrics.longTasks.length,pageLongestTaskMs:Math.max(0,...d.metrics.longTasks.map(t=>t.duration)),shellLongTasks:d.shellLongTasks?.length,
   shellLongestTaskMs:Math.max(0,...(d.shellLongTasks||[]).map(t=>t.duration)),pageHeapBefore:d.heapBefore.usedSize,pageHeapAfter:d.heapAfter.usedSize,
   totalHeapBefore:d.heapBefore.usedSize+(version==='B3'?(d.shellHeapBefore?.usedSize||0):0),totalHeapAfter:d.heapAfter.usedSize+(version==='B3'?(d.shellHeapAfter?.usedSize||0):0),
   peakServiceSubscriptions,wsEventFrames:d.received.length,exceptions:d.exceptions.length,
   proxyAbsoluteBudgets:{pageP95:pageP95!==null&&pageP95<=100,emitUpperBoundP95:emitP95!==null&&emitP95<=200,no500msPause:inputPause<=500},
   limits:d.telemetryLimits});
}
const metrics=['historyReadyMs','firstSegmentProxyMs','pageReceiptToRenderedP95Ms','wsToRenderedP95Ms','driverEmitToRenderedP95Ms','updateIntervalP95Ms','maxUpdateGapMs','pageLongestTaskMs','totalHeapAfter'];
const comparisons=metrics.map(metric=>{const b2=quantile(runs.filter(r=>r.version==='B2').map(r=>r[metric]),.5),b3=quantile(runs.filter(r=>r.version==='B3').map(r=>r[metric]),.5);return {metric,b2Median:b2,b3Median:b3,regressionPercent:b2?100*(b3/b2-1):null,within10Percent:b2?b3<=b2*1.1:null};});
const result={machine:{cpu:'Intel Core i7-1165G7',physicalCores:4,logicalProcessors:8,physicalMemoryBytes:16969424896,os:'Windows 10 10.0.19045',electron:'35.7.5',gpu:'--disable-gpu'},budgetsUnchanged:{pageP95Ms:100,runtimeP95Ms:200,maxPauseMs:500,maxRegressionPercent:10},runs,comparisons,
 acceptance:'Measurements are rendering proxies. Exact runtime-entry, post-commit and internal queue measurements are not available from the immutable B2 binary; do not treat this file as a complete B3-A8 pass.'};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,runs:runs.length,comparisons}));
