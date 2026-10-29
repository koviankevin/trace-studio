import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {TraceJSONReader,TraceIndex} from '../dist/core.js';
const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(new URL('../dist/core.js',import.meta.url))).digest('hex');
const value=i=>i%10007===3?12345:i%10007===4?-12345:.001+Math.sin(i*.1)*.0003;
if(isMainThread){
  const count=Number(process.argv[2]||1_000_000);if(!Number.isInteger(count)||count<10000)throw Error('Use at least 10000 samples');
  const worker=new Worker(new URL(import.meta.url),{workerData:{count}});
  worker.on('message',message=>{if(message.type==='result'){fs.mkdirSync('evidence',{recursive:true});fs.writeFileSync('evidence/counter-benchmark.json',JSON.stringify(message,null,2));}console.log(JSON.stringify(message));});
  worker.on('error',error=>{console.error(error);process.exitCode=1;});
}else{
  const sourceHash=hash(),folder=fs.mkdtempSync(path.join(os.tmpdir(),'trace-counter-bench-')),handles=[],files=['events.bin','index.bin'].map(name=>path.join(folder,name));
  try{
    const io=filename=>{const fd=fs.openSync(filename,'w+'),handle={write:(b,{at})=>fs.writeSync(fd,b,0,b.length,at),read:(b,{at})=>fs.readSync(fd,b,0,b.length,at),flush:()=>fs.fsyncSync(fd),close:()=>fs.closeSync(fd)};handles.push(handle);return handle;};
    const db=new TraceIndex(io(files[0]),io(files[1])),reader=new TraceJSONReader((event,text)=>db.ingest(event,text));
    let inputBytes=1,batch='',peakRSS=process.memoryUsage().rss,lastReport=0;const started=performance.now();reader.feed('[');
    for(let i=0;i<workerData.count;i++){
      batch+=`${i?',':''}${JSON.stringify({ph:'C',name:'Signal',pid:1,tid:i%4,ts:i*10,args:{value:value(i)}})}`;
      if(batch.length>=1024*1024){inputBytes+=Buffer.byteLength(batch);reader.feed(batch);batch='';peakRSS=Math.max(peakRSS,process.memoryUsage().rss);const now=performance.now();if(now-lastReport>3000){lastReport=now;parentPort.postMessage({type:'progress',samples:i+1,seconds:(now-started)/1000});}}
    }
    reader.feed(batch+']');inputBytes+=Buffer.byteLength(batch)+1;reader.end();const manifest=db.finish(),importSeconds=(performance.now()-started)/1000;
    const tracks=manifest.tracks.filter(track=>track.kind==='counter'),trackIds=tracks.map(track=>track.id),span=manifest.end-manifest.start,cold=[],warm=[];let maxNodes=0;
    for(let i=0;i<80;i++){
      const size=span/[1,10,100,1000][i%4],start=manifest.start+(span-size)*i/80,end=start+size;
      db.cache.clear();let timer=performance.now();const result=db.query({start,end,trackIds,width:1200});cold.push(performance.now()-timer);
      timer=performance.now();db.query({start,end,trackIds,width:1200});warm.push(performance.now()-timer);
      const exact=Array.from({length:4},()=>({min:Infinity,max:-Infinity}));
      for(let index=Math.ceil(start/10);index<=Math.min(workerData.count-1,Math.floor(end/10));index++){const entry=exact[index%4],v=value(index);entry.min=Math.min(entry.min,v);entry.max=Math.max(entry.max,v);}
      for(let t=0;t<result.length;t++){const rows=result[t].rows,values=rows.map(row=>row.value),expected=exact[tracks[t].tid];if(Math.min(...values)!==expected.min||Math.max(...values)!==expected.max)throw Error(`counter extrema mismatch at query ${i}`);if(rows.length>4*1201)throw Error('unbounded query');}
      maxNodes=Math.max(maxNodes,result.reduce((n,track)=>n+track.rows.length,0));peakRSS=Math.max(peakRSS,process.memoryUsage().rss);
    }
    const manifestBytes=Buffer.byteLength(JSON.stringify(manifest));peakRSS=Math.max(peakRSS,process.memoryUsage().rss);
    if(hash()!==sourceHash)throw Error('Source changed during benchmark; discard results');
    const p=(values,f)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*f)];
    parentPort.postMessage({type:'result',environment:'Node Worker + real filesystem; not browser OPFS or Canvas',createdAt:new Date().toISOString(),node:process.version,platform:`${process.platform} ${process.arch}`,cpu:os.cpus()[0].model,inputBytes,events:workerData.count,counterTracks:tracks.length,importSeconds,peakProcessRSSMB:peakRSS/1e6,diskBytes:manifest.diskBytes,manifestBytes,querySamples:80,width:1200,maxNodes,coldQueryMedianMs:p(cold,.5),coldQueryP95Ms:p(cold,.95),warmQueryMedianMs:p(warm,.5),warmQueryP95Ms:p(warm,.95),allQueriedExtremaMatch:true,sourceHashes:{'core.js':sourceHash}});
  }finally{for(const handle of handles)try{handle.close();}catch{}for(const file of files){if(path.dirname(file)!==folder)throw Error('Invalid cleanup path');try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}}fs.rmdirSync(folder);}
}
