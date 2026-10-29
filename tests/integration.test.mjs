import {removeTestRoot} from './temp-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
function next(worker,type,requestId){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{worker.off('message',handler);reject(Error(`timeout: ${type}`));},10000);const handler=m=>{if(m.type==='error'&&type!=='error'){clearTimeout(timer);worker.off('message',handler);reject(Error(m.message));}if(m.type===type&&(requestId===undefined||m.requestId===requestId)){clearTimeout(timer);worker.off('message',handler);resolve(m);}};worker.on('message',handler);worker.once('error',reject);});}
test('real worker message protocol: demo, viewport, detail, relation, search and restore',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-'));let worker;
  try{
    worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});await next(worker,'initialized');let ready=next(worker,'ready');worker.postMessage({type:'demo'});const {info}=await ready;assert.equal(info.source.demo,true);assert.equal(info.top[0].label,'Checkout interaction');assert(info.relations.count>0);assert(!('blocks'in info));
    let reply=next(worker,'query',1);worker.postMessage({type:'query',requestId:1,start:info.start,end:info.end,trackIds:[0],width:1000});assert((await reply).rows[0].rows.length>0);
    reply=next(worker,'detail',2);worker.postMessage({type:'detail',requestId:2,record:info.top[0]});const d=await reply;assert.equal(d.links.matches.length,3);assert.equal(d.event.args.address,'0x00007FFE1010');
    reply=next(worker,'search',3);worker.postMessage({type:'search',requestId:3,term:'checkout interaction'});assert.equal((await reply).results[0].label,'Checkout interaction');
    reply=next(worker,'neighbor',4);worker.postMessage({type:'neighbor',requestId:4,record:info.top[0],direction:1});assert((await reply).record);
    await worker.terminate();worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});await next(worker,'initialized');ready=next(worker,'ready');worker.postMessage({type:'restore',id:info.id});const restored=await ready;assert(restored.restored);assert.equal(restored.info.count,info.count);
    reply=next(worker,'detail',5);worker.postMessage({type:'detail',requestId:5,record:info.top[0]});assert.equal((await reply).links.matches.length,3);
  }finally{await worker?.terminate();await removeTestRoot(root);}
});
test('worker streams gzip and reports malformed input without a successful import',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-'));const worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});
  try{
    await next(worker,'initialized');let reply=next(worker,'ready');worker.postMessage({type:'import',file:new File([gzipSync('[{"name":"gzip 測試","ph":"X","ts":0,"dur":10}]')],'test.json.gz')});const ready=await reply;assert.equal(ready.info.count,1);
    reply=next(worker,'error');worker.postMessage({type:'import',file:new File(['[{"name":'],'bad.json')});assert.match((await reply).message,/不完整/);
    reply=next(worker,'cleared');worker.postMessage({type:'clear'});await reply;
  }finally{await worker.terminate();await removeTestRoot(root);}
});

test('gzip is detected by header and missing quota estimates do not reject valid files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root,storageEstimate:{}}});
  const json='[{"name":"Header detected","ph":"X","ts":0,"dur":10}]';
  try{
    await next(worker,'initialized');
    for(const [content,name]of [[json,'plain.json'],[gzipSync(json),'TRACE.JSON.GZ'],[gzipSync(json),'compressed.json']]){
      const reply=next(worker,'ready');worker.postMessage({type:'import',file:new File([content],name)});assert.equal((await reply).info.count,1);
    }
    const reply=next(worker,'error');worker.postMessage({type:'import',file:new File([json],'not-gzip.json.gz')});assert.match((await reply).message,/gzip/);
  }finally{await worker.terminate();await removeTestRoot(root);}
});

test('disk initialization failures release handles and remove the incomplete session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root,failOpenOnce:['relations.bin']}});
  const file=new File(['[{"ph":"X","name":"Recovered","ts":0,"dur":10}]'],'disk.json');
  try{
    await next(worker,'initialized');let reply=next(worker,'error');worker.postMessage({type:'import',file});assert.match((await reply).message,/disk open failure/);
    assert.deepEqual(await readdir(join(root,'trace-studio-v1')),[]);
    reply=next(worker,'ready');worker.postMessage({type:'import',file});assert.equal((await reply).info.count,1);
  }finally{await worker.terminate();await removeTestRoot(root);}
});

test('clearing caches preserves another worker active session and reports it as busy',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),workers=[];
  try{
    for(let i=0;i<2;i++){const worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});workers.push(worker);await next(worker,'initialized');}
    let reply=next(workers[0],'ready');workers[0].postMessage({type:'demo'});const first=(await reply).info;
    reply=next(workers[1],'ready');workers[1].postMessage({type:'demo'});const second=(await reply).info;
    reply=next(workers[1],'cleared');workers[1].postMessage({type:'clear'});const result=await reply;
    assert((await readdir(join(root,'trace-studio-v1'))).includes(first.id),'another tab cache must not be removed');
    assert(!((await readdir(join(root,'trace-studio-v1'))).includes(second.id)));
    assert(result.skipped.some(item=>item.id===first.id&&item.reason==='busy'));
    reply=next(workers[0],'query',30);workers[0].postMessage({type:'query',requestId:30,start:first.start,end:first.end,trackIds:[0],width:1000});assert((await reply).rows[0].rows.length);
  }finally{await Promise.all(workers.map(worker=>worker.terminate()));await removeTestRoot(root);}
});

test('session manager lists lightweight cache entries, skips active locks and releases them on termination',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),workers=[];
  try{
    for(let i=0;i<2;i++){const worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});workers.push(worker);await next(worker,'initialized');}
    let reply=next(workers[0],'ready');workers[0].postMessage({type:'demo'});const first=(await reply).info;
    reply=next(workers[1],'ready');workers[1].postMessage({type:'demo'});const second=(await reply).info;
    reply=next(workers[1],'sessions',40);workers[1].postMessage({type:'sessions',requestId:40});const entries=(await reply).sessions;
    assert.equal(entries.length,2);assert(entries.every(entry=>entry.complete&&entry.bytes>0&&entry.name==='checkout-flow.demo.json'&&!('blocks'in entry)));
    assert(entries.find(entry=>entry.id===second.id).current);assert(entries.find(entry=>entry.id===first.id).busy);
    reply=next(workers[1],'sessionRemoved',41);workers[1].postMessage({type:'removeSession',id:first.id,requestId:41});assert.equal((await reply).reason,'busy');
    reply=next(workers[1],'unusedCleared',42);workers[1].postMessage({type:'clearUnused',requestId:42});assert.equal((await reply).removed.length,0);
    reply=next(workers[1],'error');workers[1].postMessage({type:'restore',id:first.id});assert.match((await reply).message,/其他分頁/);
    await workers[0].terminate();
    reply=next(workers[1],'ready');workers[1].postMessage({type:'restore',id:first.id});assert.equal((await reply).info.id,first.id);
    reply=next(workers[1],'sessionRemoved',43);workers[1].postMessage({type:'removeSession',id:second.id,requestId:43});assert((await reply).removed);
    reply=next(workers[1],'error');workers[1].postMessage({type:'removeSession',id:'../escape'});assert.match((await reply).message,/識別碼/);
  }finally{await Promise.all(workers.map(worker=>worker.terminate()));await removeTestRoot(root);}
});

test('an interrupted import can be reclaimed, while an active incomplete import stays protected',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root,slowInput:true}}),cleaner=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});
  try{
    await Promise.all([next(worker,'initialized'),next(cleaner,'initialized')]);
    const text=JSON.stringify(Array.from({length:20000},(_,i)=>({name:'Cancelled import',ph:'X',ts:i,dur:1,args:{payload:'x'.repeat(100)}})));
    let reply=next(worker,'progress');worker.postMessage({type:'import',file:new File([text],'interrupted.json')});await reply;
    reply=next(cleaner,'sessions',50);cleaner.postMessage({type:'sessions',requestId:50});const entry=(await reply).sessions[0];assert.equal(entry.name,'interrupted.json');assert(!entry.complete&&entry.busy);
    reply=next(cleaner,'unusedCleared',51);cleaner.postMessage({type:'clearUnused',requestId:51});assert.equal((await reply).removed.length,0);
    await worker.terminate();
    reply=next(cleaner,'unusedCleared',52);cleaner.postMessage({type:'clearUnused',requestId:52});assert.deepEqual((await reply).removed,[entry.id]);assert.deepEqual(await readdir(join(root,'trace-studio-v1')),[]);
  }finally{await worker.terminate();await cleaner.terminate();await removeTestRoot(root);}
});
test('hardware demo worker supplies grouped summaries and keeps selected event hardware fields',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});
  try{
    await next(worker,'initialized');let reply=next(worker,'ready');worker.postMessage({type:'hardwareDemo'});const {info}=await reply;assert.equal(Object.keys(info.processes).length,4);assert.equal(info.tracks.filter(t=>t.count).length,112);assert.equal(info.source.demo,true);
    const ids=info.tracks.filter(t=>t.pid===100).map(t=>t.id);reply=next(worker,'query',7);worker.postMessage({type:'query',requestId:7,start:info.start,end:info.end,trackIds:[],groups:[{id:'process:100',trackIds:ids}],width:1000});
    const grouped=await reply;assert.deepEqual(grouped.rows,[]);assert.equal(grouped.groups[0].id,'process:100');assert(grouped.groups[0].bins.some(n=>n>0));assert(grouped.groups[0].bins.length<=240);
    reply=next(worker,'detail',8);worker.postMessage({type:'detail',requestId:8,record:info.top[0]});const detail=await reply;assert.deepEqual(detail.event.args.input_shape,[12,12,64]);assert.equal(detail.event.args.demo,true);assert(detail.links.matches.length>0);
  }finally{await worker.terminate();await removeTestRoot(root);}
});
test('worker analysis remains queryable, cancels and returns accurate index-only summaries',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});
  try{
    await next(worker,'initialized');let reply=next(worker,'ready');worker.postMessage({type:'hardwareDemo'});const {info}=await reply,trackIds=info.tracks.map(t=>t.id);
    const progress=next(worker,'analysisProgress',20);worker.postMessage({type:'analysis',requestId:20,start:info.start,end:info.end,trackIds,thresholdUs:1000});await progress;
    const cancelled=next(worker,'analysisCancelled',20),viewport=next(worker,'query',21);worker.postMessage({type:'query',requestId:21,start:info.start,end:info.end,trackIds:[trackIds[0]],width:1000});worker.postMessage({type:'cancelAnalysis'});assert((await viewport).rows[0].rows.length>0);await cancelled;
    reply=next(worker,'analysis',22);worker.postMessage({type:'analysis',requestId:22,start:info.start,end:info.end,trackIds,thresholdUs:1000});const result=(await reply).result;assert.equal(result.complete,8960);assert.equal(result.tracks.length,112);assert.deepEqual(result.extensions,[]);assert(result.longEvents>0);assert(result.longest.length<=50);
  }finally{await worker.terminate();await removeTestRoot(root);}
});

test('counter envelopes, boundary context and raw details survive the actual worker cache restore',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-'));let worker;
  try{
    worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});await next(worker,'initialized');
    const events=Array.from({length:12000},(_,i)=>({ph:'C',name:'Power',pid:1,tid:1,ts:i*10,args:{watts:i===101?999:i===102?-999:10}}));
    let reply=next(worker,'ready');worker.postMessage({type:'import',file:new File([JSON.stringify(events)],'power.json')});const info=(await reply).info,id=info.tracks.find(t=>t.kind==='counter').id;assert.equal(info.counterSummaryVersion,1);
    for(let pass=0;pass<2;pass++){
      reply=next(worker,'query',60+pass);worker.postMessage({type:'query',requestId:60+pass,start:0,end:info.end,width:4,trackIds:[id]});const rows=(await reply).rows[0].rows;assert.equal(Math.max(...rows.map(r=>r.value)),999);assert.equal(Math.min(...rows.map(r=>r.value)),-999);
      reply=next(worker,'detail',70+pass);worker.postMessage({type:'detail',requestId:70+pass,record:rows.find(r=>r.value===999)});assert.equal((await reply).event.args.watts,999);
      if(pass===0){await worker.terminate();worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});await next(worker,'initialized');reply=next(worker,'ready');worker.postMessage({type:'restore',id:info.id});await reply;}
    }
    reply=next(worker,'query',80);worker.postMessage({type:'query',requestId:80,start:502,end:505,width:100,trackIds:[id]});const result=(await reply).rows[0];assert.equal(result.rows.length,0);assert.equal(result.before.ts,500);assert.equal(result.after.ts,510);
  }finally{await worker?.terminate();await removeTestRoot(root);}
});
test('application element references and local assets exist; engine benchmark hashes match',async()=>{
  const base=new URL('../dist/',import.meta.url),html=await readFile(new URL('index.html',base),'utf8'),app=await readFile(new URL('app.js',base),'utf8');
  const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));const dynamic=new Set(['area-focus','show-relations']);
  for(const m of app.matchAll(/\$\('([^']+)'\)/g))assert(ids.has(m[1])||dynamic.has(m[1]),`Missing #${m[1]}`);
  for(const asset of ['style.css','workspace.css','app.js','worker.js','core.js','relations.js','navigation.js','track-layout.js','event-summary.js','event-colors.js','analysis.js','session-store.js','counter-plot.js','extensions/runtime.js','extensions/custom.js','extensions/example.js','hardware-demo.js','icon.svg'])assert((await readFile(new URL(asset,base))).length>0);
  const benchmark=JSON.parse(await readFile(new URL('../docs/benchmark-2026-10-29-v0.3.2.json',import.meta.url),'utf8'));
  for(const [file,expected]of Object.entries(benchmark.sourceHashes))assert.equal(createHash('sha256').update(await readFile(new URL(file,base))).digest('hex'),expected,`Rerun benchmark after changing ${file}`);
  const counters=JSON.parse(await readFile(new URL('../docs/counter-benchmark-2026-10-29-v0.3.2.json',import.meta.url),'utf8'));assert.equal(counters.sourceHashes['core.js'],benchmark.sourceHashes['core.js']);
});
