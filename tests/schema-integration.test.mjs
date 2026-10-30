import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtemp,mkdir,cp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {removeTestRoot} from './temp-files.mjs';

function reply(worker,type,id){return new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);worker.off('message',onMessage);worker.off('error',onError);},onError=e=>{done();reject(e);},onMessage=m=>{if(m.type==='error'){done();reject(Error(m.message));}else if(m.type===type&&(id===undefined||m.requestId===id)){done();resolve(m);}},timer=setTimeout(()=>onError(Error('Worker schema response timeout')),10000);worker.on('message',onMessage);worker.once('error',onError);});}

test('custom schema reaches actual Worker detail, argument analysis, and cross-trace comparison',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-studio-test-'));let worker;
  try{
    const app=join(root,'app'),storage=join(root,'storage');await mkdir(storage);await cp(new URL('../dist/',import.meta.url),app,{recursive:true});
    await writeFile(join(app,'extensions/custom.js'),`export default [{id:'internal',argumentSchema:{idFields:{tflite:['my_operator'],flow:['my_link']},memoryFields:{start:['my_start'],size:['my_bytes'],location:['my_space']}}}];`);
    worker=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root:storage,entry:pathToFileURL(join(app,'worker.js')).href}});await reply(worker,'initialized');
    const sessions=[];let record;
    for(let i=0;i<2;i++){
      const next=reply(worker,'ready');worker.postMessage({type:'import',file:new File([JSON.stringify([{ph:'X',name:'Compute',pid:1,tid:1,ts:0,dur:10+i,args:{my_operator:7,my_link:9,buffer:{my_start:'0x1000',my_bytes:256,my_space:'OUTPUT_LOCAL'}}}])],`variant-${i}.json`)});
      const {info}=await next;sessions.push(info.id);record=info.top[0];
    }
    let next=reply(worker,'detail',1);worker.postMessage({type:'detail',requestId:1,record});const detail=await next;assert.equal(detail.facts.ids.tflite,'7');assert.equal(detail.facts.ids.flow,'9');assert.equal(detail.facts.memories[0].bytes,'256');
    next=reply(worker,'analysis',2);worker.postMessage({type:'analysis',requestId:2,includeArguments:true,argumentFocus:{kind:'flow',value:'9'}});const analysis=await next;assert.equal(analysis.result.arguments.matched,1);assert.equal(analysis.result.arguments.memoryRanges,1);
    next=reply(worker,'comparison',3);worker.postMessage({type:'compare',requestId:3,ids:sessions,tfliteId:'7'});const comparison=await next;assert.deepEqual(comparison.result.traces.map(t=>t.matched),[1,1]);assert(comparison.result.traces.every(t=>t.locations[0].declaredBytes==='256'));
  }finally{await worker?.terminate();await removeTestRoot(root);}
});
