// Dense, deliberately reused address; filesystem adapter, not browser OPFS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {TraceIndex} from '../dist/core.js';
import {RelationIndex} from '../dist/relations.js';

const count=Number(process.argv[2]||1000000);
if(!Number.isInteger(count)||count<1000||count>1000000)throw Error('count must be 1000..1000000');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'trace-studio-relations-')),handles=[],files=[];
try{
  const io=name=>{const filename=path.join(folder,name),fd=fs.openSync(filename,'w+');files.push(filename);handles.push(fd);return {write:(b,{at})=>fs.writeSync(fd,b,0,b.length,at),read:(b,{at})=>fs.readSync(fd,b,0,b.length,at),flush:()=>fs.fsyncSync(fd)};};
  const trace=new TraceIndex(io('events.bin'),io('index.bin')),relations=new RelationIndex(io('relations.bin'),trace);
  trace.onEvent=(event,ref)=>relations.add(event,ref);let peakRSS=0;const started=performance.now();
  for(let i=0;i<count;i++){const event={ph:'X',name:'reuse',pid:1,tid:1,ts:i*10,dur:5,args:{address:'0x1000'}};trace.ingest(event,JSON.stringify(event));if(!(i%4096))peakRSS=Math.max(peakRSS,process.memoryUsage().rss);}
  const manifest=trace.finish(),linkManifest=relations.finish(),importSeconds=(performance.now()-started)/1000;
  // Restore the same on-disk format; lookup must not depend on import buffers.
  const restored=new TraceIndex(trace.raw.handle,trace.index.handle).restore(manifest),links=new RelationIndex(relations.handle,restored);links.restore(linkManifest);
  const samples=[];
  for(const at of [Math.floor(count/2),count-20]){
    const ts=at*10,record=restored.query({start:ts,end:ts+5,trackIds:[0],width:1000})[0].rows.find(r=>r.ts===ts),event=restored.detail(record).event;
    let yields=0,queryMs=null;const start=performance.now();
    const result=await links.findAsync(event,record,undefined,{yieldNow:async()=>{yields++;if(queryMs===null){const q=performance.now();assert(restored.query({start:ts,end:ts+100,trackIds:[0],width:1000})[0].rows.length);queryMs=performance.now()-q;}await new Promise(resolve=>setTimeout(resolve,0));}});
    const elapsedMs=performance.now()-start;
    assert.equal(result.indexHits,count-1);assert.equal(result.matches.length,64);assert(result.sampled);assert(result.matches.some(m=>m.record.ts===ts-10));assert(result.matches.some(m=>m.record.ts===ts+10));assert(result.rawChecked<=256);
    samples.push({selectedIndex:at,elapsedMs,yields,interleavedQueryMs:queryMs,results:result.matches.length,rawChecked:result.rawChecked,indexHits:result.indexHits,limits:result.limits});
  }
  const record=restored.query({start:0,end:1,trackIds:[0],width:1000})[0].rows[0];let cancelled=false;const start=performance.now();
  await assert.rejects(links.findAsync(restored.detail(record).event,record,undefined,{cancelled:()=>cancelled,yieldNow:async()=>{cancelled=true;await new Promise(resolve=>setTimeout(resolve,0));}}),{name:'AbortError'});
  const cancelAfterFirstYieldMs=performance.now()-start;
  const sourceHashes=Object.fromEntries(['core.js','relations.js'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(new URL('../dist/'+name,import.meta.url))).digest('hex')]));
  const output={environment:'Node filesystem adapter; synthetic X events sharing one address; cooperative query is invoked at a yield, actual Worker message interleaving is tested separately',node:process.version,platform:process.platform,cpu:os.cpus()[0].model,events:count,importSeconds,peakProcessRSSMB:Math.max(peakRSS,process.memoryUsage().rss)/1e6,diskBytes:manifest.diskBytes+linkManifest.bytes,samples,cancelAfterFirstYieldMs,sourceHashes,createdAt:new Date().toISOString()};
  fs.mkdirSync('evidence',{recursive:true});fs.writeFileSync('evidence/relation-benchmark.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
}finally{
  for(const fd of handles)fs.closeSync(fd);
  for(const file of files){if(path.dirname(file)!==folder)throw Error('Unexpected cleanup path');fs.unlinkSync(file);}fs.rmdirSync(folder);
}
