import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {TraceJSONReader,TraceIndex} from '../dist/core.js';
import {RelationIndex} from '../dist/relations.js';
if(isMainThread){
  const target=Number(process.argv[2]||3_000_000_000);let maxDelay=0,ticks=0,last=performance.now();
  const timer=setInterval(()=>{const now=performance.now();maxDelay=Math.max(maxDelay,now-last-20);last=now;ticks++;},20);
  const worker=new Worker(new URL(import.meta.url),{workerData:{target}});
  worker.on('message',data=>{if(data.type==='progress')console.log(JSON.stringify(data));else{clearInterval(timer);const result={...data,mainThreadTicks:ticks,maxMainThreadTimerDelayMs:maxDelay};fs.mkdirSync('evidence',{recursive:true});fs.writeFileSync('evidence/benchmark.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}});
  worker.on('error',e=>{clearInterval(timer);console.error(e);process.exitCode=1;});
}else{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'trace-studio-bench-'));
  const files=['events.bin','index.bin','relations.bin'].map(x=>path.join(folder,x));let handles=[];
  try{
    const io=filename=>{const fd=fs.openSync(filename,'w+');const h={write:(b,{at})=>fs.writeSync(fd,b,0,b.length,at),read:(b,{at})=>fs.readSync(fd,b,0,b.length,at),flush:()=>fs.fsyncSync(fd),close:()=>fs.closeSync(fd)};handles.push(h);return h;};
    const trace=new TraceIndex(io(files[0]),io(files[1])),relations=new RelationIndex(io(files[2]),trace);trace.onEvent=(e,r)=>relations.add(e,r);
    const reader=new TraceJSONReader((e,text)=>trace.ingest(e,text));let size=16,events=0,maxRSS=0,lastReport=0;const started=performance.now();reader.feed('{"traceEvents":[');
    const payload='x'.repeat(900);let batch='';
    while(size<workerData.target){batch+=`${events?',':''}{"name":"Task ${events%12}","ph":"X","pid":1,"tid":${events%8},"ts":${events*100},"dur":50,"cat":"benchmark","args":{"payload":"${payload}","index":${events}${events%25===0?`,"address":"0x${(events%8192+4096).toString(16)}"`:''}}}`;events++;
      if(batch.length>=1024*1024){reader.feed(batch);size+=Buffer.byteLength(batch);batch='';maxRSS=Math.max(maxRSS,process.memoryUsage().rss);const now=performance.now();if(now-lastReport>3000){lastReport=now;parentPort.postMessage({type:'progress',bytes:size,events,seconds:(now-started)/1000,rssMB:Math.round(process.memoryUsage().rss/1e6)});}}
    }
    if(batch){reader.feed(batch);size+=Buffer.byteLength(batch);}reader.feed(']}');size+=2;reader.end();const manifest=trace.finish(),links=relations.finish(),seconds=(performance.now()-started)/1000;
    const queryTimes=[],cold=[];const trackIds=manifest.tracks.map(t=>t.id),total=manifest.end-manifest.start;
    for(let i=0;i<80;i++){const window=total/[1,10,100,1000][i%4],start=manifest.start+(total-window)*(i/80);trace.cache.clear();let t=performance.now();const rows=trace.query({start,end:start+window,trackIds,width:1200});cold.push(performance.now()-t);t=performance.now();trace.query({start,end:start+window,trackIds,width:1200});queryTimes.push(performance.now()-t);if(!rows.some(t=>t.rows.length))throw Error('empty query');}
    const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.floor((a.length-1)*p)];
    const r=trace.query({start:manifest.start,end:manifest.start+1,trackIds:[0],width:1200})[0].rows[0];const detail=trace.detail(r);let rt=performance.now();const related=relations.find(detail.event,r);rt=performance.now()-rt;
    const sourceHashes=Object.fromEntries(['core.js','relations.js'].map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(new URL('../dist/'+n,import.meta.url))).digest('hex')]));
    parentPort.postMessage({type:'result',environment:'Node worker_threads + real filesystem adapter; not a browser OPFS or rendered UI benchmark',node:process.version,platform:`${process.platform} ${process.arch}`,cpu:os.cpus()[0].model,logicalCPUs:os.cpus().length,ramGB:os.totalmem()/1e9,inputBytes:size,events,tracks:trackIds.length,relationKeys:links.count,importSeconds:seconds,throughputMBps:size/1e6/seconds,peakProcessRSSMB:maxRSS/1e6,diskBytes:manifest.diskBytes+links.bytes,querySamples:80,coldQueryMedianMs:percentile(cold,.5),coldQueryP95Ms:percentile(cold,.95),warmQueryMedianMs:percentile(queryTimes,.5),warmQueryP95Ms:percentile(queryTimes,.95),addressLookupMs:rt,addressMatches:related.matches.length,sourceHashes,createdAt:new Date().toISOString()});
  }finally{
    for(const h of handles)try{h.close();}catch{}
    for(const file of files){if(path.dirname(file)!==folder)throw Error('Unexpected cleanup path');try{fs.unlinkSync(file);}catch{}}
    fs.rmdirSync(folder);
  }
}
