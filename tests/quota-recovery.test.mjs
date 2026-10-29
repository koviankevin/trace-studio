import test from 'node:test';import assert from 'node:assert/strict';import {Worker} from 'node:worker_threads';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {gzipSync} from 'node:zlib';import {removeTestRoot} from './temp-files.mjs';
function next(worker,type,id){return new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);worker.off('message',receive);worker.off('error',failed);},failed=error=>{cleanup();reject(error);},timer=setTimeout(()=>failed(Error('timeout '+type)),10000),receive=data=>{if(data.type==='error'&&type!=='error')return failed(Error(data.message));if(data.type===type&&(id===undefined||data.requestId===id)){cleanup();resolve(data);}};worker.on('message',receive);worker.once('error',failed);});}
test('quota preflight rejection must report promptly even when upstream cancellation never settles',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root,pendingCancel:true}});
  try{await next(worker,'initialized');let reply=next(worker,'ready',1);worker.postMessage({type:'import',requestId:1,file:new File(['[{"ph":"X","name":"keep","pid":1,"tid":1,"ts":0,"dur":10}]'],'previous.json')});const previous=(await reply).info;
    reply=next(worker,'testQuotaConfigured',2);worker.postMessage({type:'testQuotaEstimate',requestId:2,estimate:{quota:0,usage:0}});await reply;
    let timer;const timeout=new Promise((resolve,reject)=>timer=setTimeout(()=>reject(Error('quota preflight is blocked waiting for stream cancellation')),1000));reply=next(worker,'error',3);worker.postMessage({type:'import',requestId:3,file:new File(['[]'],'reject.json')});let failure;try{failure=await Promise.race([reply,timeout]);}finally{clearTimeout(timer);}assert.match(failure.message,/儲存空間不足/);
    reply=next(worker,'ready',4);worker.postMessage({type:'restore',requestId:4,id:previous.id});assert.equal((await reply).info.top[0].label,'keep');reply=next(worker,'sessions',5);worker.postMessage({type:'sessions',requestId:5});assert.equal((await reply).sessions.length,1);
  }finally{await worker.terminate();await removeTestRoot(root);}
});
test('quota failures in raw/index/relations/manifest/session writes preserve the previous trace and release partial sessions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});
  try{await next(worker,'initialized');let reply=next(worker,'ready',1);const previousEvent={ph:'X',name:'keep',pid:1,tid:1,ts:0,dur:10,args:{retained:'🌏'}};worker.postMessage({type:'import',requestId:1,file:new File([JSON.stringify([previousEvent])],'previous.json')});const previous=(await reply).info;
    const large=JSON.stringify(Array.from({length:3000},(_,ts)=>({ph:'X',name:'work',pid:1,tid:1,ts,dur:1,args:{payload:'x'.repeat(500),address:'0x1000'}})));
    let id=10;for(const name of ['events.bin','index.bin','relations.bin','manifest.json','session.json']){
      reply=next(worker,'testWriteFaultConfigured',id);worker.postMessage({type:'testWriteFault',requestId:id,name,after:0});await reply;id++;
      reply=next(worker,'error',id);worker.postMessage({type:'import',requestId:id,file:new File([gzipSync(large)],'large.json.gz')});const failure=await reply;assert.equal(failure.code,'QuotaExceededError',name);assert.match(failure.message,/額度不足/);id++;
      reply=next(worker,'sessions',id);worker.postMessage({type:'sessions',requestId:id});const sessions=(await reply).sessions;assert.equal(sessions.length,1,name+' partial session must be removed');assert.equal(sessions[0].id,previous.id);id++;
      reply=next(worker,'ready',id);worker.postMessage({type:'restore',requestId:id,id:previous.id});assert((await reply).memoryRestored,name+' previous index must remain in the same worker');id++;
      reply=next(worker,'detail',id);worker.postMessage({type:'detail',requestId:id,record:previous.top[0]});assert.deepEqual((await reply).event,previousEvent);id++;
    }
    reply=next(worker,'ready',id);worker.postMessage({type:'import',requestId:id,file:new File(['[{"ph":"X","name":"next","pid":1,"tid":1,"ts":0,"dur":1}]'],'next.json')});assert.equal((await reply).info.top[0].label,'next');
  }finally{await worker.terminate();await removeTestRoot(root);}
});
