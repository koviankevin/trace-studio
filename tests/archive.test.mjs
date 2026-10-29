import test from 'node:test';import assert from 'node:assert/strict';import {Worker} from 'node:worker_threads';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {gzipSync} from 'node:zlib';import {tarFixture} from './tar-fixture.mjs';import {removeTestRoot} from './temp-files.mjs';
function next(worker,type,id){return new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);worker.off('message',receive);worker.off('error',failed);},failed=error=>{cleanup();reject(error);},timer=setTimeout(()=>failed(Error('timeout '+type)),10000),receive=data=>{if(data.type==='error'&&type!=='error')return failed(Error(data.message));if(data.type===type&&(id===undefined||data.requestId===id)){cleanup();resolve(data);}};worker.on('message',receive);worker.once('error',failed);});}
const json=name=>JSON.stringify([{name,ph:'X',pid:1,tid:1,ts:0,dur:10,args:{TfliteID:7}}]);
test('tar.gz imports independent JSON and nested JSON.gz sessions, preserving successful members after invalid JSON',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});
  try{await next(worker,'initialized');const bytes=tarFixture([{name:'traces/a.json',data:json('A')},{name:'readme.txt',data:'ignore'},{name:'../unsafe.json',data:json('unsafe')},{name:'traces/b.json.gz',data:gzipSync(json('B'))},{name:'broken.json',data:'{"traceEvents":['}],{gzip:true});
    let reply=next(worker,'ready',1);worker.postMessage({type:'import',requestId:1,file:new File([bytes],'bundle.tar.gz')});const result=await reply;assert.equal(result.archive.imported,2);assert.equal(result.archive.failed,1);assert.equal(result.archive.skipped,2);assert.equal(result.info.source.archive.path,'traces/b.json.gz');assert.equal(result.info.metadata.archiveImport.failed,1);assert.equal(result.info.top[0].label,'B');
    reply=next(worker,'sessions',2);worker.postMessage({type:'sessions',requestId:2});const entries=(await reply).sessions;assert.equal(entries.length,2);assert(entries.every(entry=>entry.complete));
    reply=next(worker,'ready',3);worker.postMessage({type:'restore',requestId:3,id:entries.find(entry=>entry.name.includes('a.json')).id});assert.equal((await reply).info.top[0].label,'A');
  }finally{await worker.terminate();await removeTestRoot(root);}
});
test('tar corruption reports partial success without discarding completed traces, and empty archives fail clearly',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});
  try{await next(worker,'initialized');const bytes=tarFixture([{name:'valid.json',data:json('saved')},{name:'next.json',data:json('truncated')}]).subarray(0,1024+513);let reply=next(worker,'ready',1);worker.postMessage({type:'import',requestId:1,file:new File([bytes],'partial.tar')});const result=await reply;assert.equal(result.archive.imported,1);assert.equal(result.archive.complete,false);assert.equal(result.info.top[0].label,'saved');
    reply=next(worker,'error',2);worker.postMessage({type:'import',requestId:2,file:new File([tarFixture([{name:'notes.txt',data:'nothing'}],{gzip:true})],'no-trace.tgz')});assert.match((await reply).message,/沒有可讀/);
    reply=next(worker,'query',3);worker.postMessage({type:'query',requestId:3,start:0,end:10,width:100,trackIds:[0]});assert.equal((await reply).rows[0].rows[0].label,'saved');
  }finally{await worker.terminate();await removeTestRoot(root);}
});

test('cancelling a streaming import cleans the partial session before restoring in the same worker',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-')),worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root,slowInput:true}});
  try{await next(worker,'initialized');let reply=next(worker,'ready',1);worker.postMessage({type:'import',requestId:1,file:new File([json('keep')],'previous.json')});const previous=(await reply).info.id;
    const events=Array.from({length:3000},(_,ts)=>({name:'large',ph:'X',pid:1,tid:1,ts,dur:1,args:{payload:'x'.repeat(500)}}));
    reply=next(worker,'progress');worker.postMessage({type:'import',requestId:2,file:new File([JSON.stringify(events)],'cancel.json')});await reply;
    reply=next(worker,'importCancelled',2);worker.postMessage({type:'cancelImport',requestId:2});await reply;
    reply=next(worker,'sessions',3);worker.postMessage({type:'sessions',requestId:3});const entries=(await reply).sessions;assert.equal(entries.length,1);assert.equal(entries[0].id,previous);assert(entries[0].complete);
    reply=next(worker,'ready',4);worker.postMessage({type:'restore',requestId:4,id:previous});const restored=await reply;assert.equal(restored.info.top[0].label,'keep');assert(restored.memoryRestored);
    reply=next(worker,'importCancelUnavailable',5);worker.postMessage({type:'cancelImport',requestId:5});await reply;
  }finally{await worker.terminate();await removeTestRoot(root);}
});
