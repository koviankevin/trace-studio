import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
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
  }finally{await worker?.terminate();await rm(root,{recursive:true});}
});
test('worker streams gzip and reports malformed input without a successful import',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-'));const worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});
  try{
    await next(worker,'initialized');let reply=next(worker,'ready');worker.postMessage({type:'import',file:new File([gzipSync('[{"name":"gzip 測試","ph":"X","ts":0,"dur":10}]')],'test.json.gz')});const ready=await reply;assert.equal(ready.info.count,1);
    reply=next(worker,'error');worker.postMessage({type:'import',file:new File(['[{"name":'],'bad.json')});assert.match((await reply).message,/不完整/);
    reply=next(worker,'cleared');worker.postMessage({type:'clear'});await reply;
  }finally{await worker.terminate();await rm(root,{recursive:true});}
});
test('hardware demo worker supplies grouped summaries and keeps selected event hardware fields',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});
  try{
    await next(worker,'initialized');let reply=next(worker,'ready');worker.postMessage({type:'hardwareDemo'});const {info}=await reply;assert.equal(Object.keys(info.processes).length,4);assert.equal(info.tracks.filter(t=>t.count).length,112);assert.equal(info.source.demo,true);
    const ids=info.tracks.filter(t=>t.pid===100).map(t=>t.id);reply=next(worker,'query',7);worker.postMessage({type:'query',requestId:7,start:info.start,end:info.end,trackIds:[],groups:[{id:'process:100',trackIds:ids}],width:1000});
    const grouped=await reply;assert.deepEqual(grouped.rows,[]);assert.equal(grouped.groups[0].id,'process:100');assert(grouped.groups[0].bins.some(n=>n>0));assert(grouped.groups[0].bins.length<=240);
    reply=next(worker,'detail',8);worker.postMessage({type:'detail',requestId:8,record:info.top[0]});const detail=await reply;assert.deepEqual(detail.event.args.input_shape,[12,12,64]);assert.equal(detail.event.args.demo,true);assert(detail.links.matches.length>0);
  }finally{await worker.terminate();await rm(root,{recursive:true});}
});
test('worker analysis remains queryable, cancels and returns accurate index-only summaries',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});
  try{
    await next(worker,'initialized');let reply=next(worker,'ready');worker.postMessage({type:'hardwareDemo'});const {info}=await reply,trackIds=info.tracks.map(t=>t.id);
    const progress=next(worker,'analysisProgress',20);worker.postMessage({type:'analysis',requestId:20,start:info.start,end:info.end,trackIds,thresholdUs:1000});await progress;
    const cancelled=next(worker,'analysisCancelled',20),viewport=next(worker,'query',21);worker.postMessage({type:'query',requestId:21,start:info.start,end:info.end,trackIds:[trackIds[0]],width:1000});worker.postMessage({type:'cancelAnalysis'});assert((await viewport).rows[0].rows.length>0);await cancelled;
    reply=next(worker,'analysis',22);worker.postMessage({type:'analysis',requestId:22,start:info.start,end:info.end,trackIds,thresholdUs:1000});const result=(await reply).result;assert.equal(result.complete,8960);assert.equal(result.tracks.length,112);assert.deepEqual(result.extensions,[]);assert(result.longEvents>0);assert(result.longest.length<=50);
  }finally{await worker.terminate();await rm(root,{recursive:true});}
});
test('application element references and local assets exist; engine benchmark hashes match',async()=>{
  const base=new URL('../dist/',import.meta.url),html=await readFile(new URL('index.html',base),'utf8'),app=await readFile(new URL('app.js',base),'utf8');
  const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));const dynamic=new Set(['area-focus','show-relations']);
  for(const m of app.matchAll(/\$\('([^']+)'\)/g))assert(ids.has(m[1])||dynamic.has(m[1]),`Missing #${m[1]}`);
  for(const asset of ['style.css','workspace.css','app.js','worker.js','core.js','relations.js','navigation.js','track-layout.js','event-summary.js','event-colors.js','analysis.js','extensions/runtime.js','extensions/custom.js','extensions/example.js','hardware-demo.js','icon.svg'])assert((await readFile(new URL(asset,base))).length>0);
  const benchmark=JSON.parse(await readFile(new URL('../docs/benchmark-2026-10-29-v0.2.1.json',import.meta.url),'utf8'));
  for(const [file,expected]of Object.entries(benchmark.sourceHashes))assert.equal(createHash('sha256').update(await readFile(new URL(file,base))).digest('hex'),expected,`Rerun benchmark after changing ${file}`);
});
