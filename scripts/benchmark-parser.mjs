// Parser-only corpus, bounded to one ~1 MiB input batch in memory.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const source=process.argv[2]||'dist/core.js',output=process.argv[3]||'evidence/parser-benchmark.json';
const {TraceJSONReader}=await import(pathToFileURL(path.resolve(source)));
const profiles=[
  {name:'long plain args',args:{payload:'x'.repeat(900)}},
  {name:'escaped and structural text',args:{payload:('hello \\ " [nested] {text} 中文 🌏\n').repeat(25),nested:[null,true,12,{value:'ends\\'}]}},
  {name:'many small fields',args:Object.fromEntries(Array.from({length:70},(_,i)=>['field'+i,i%3?'short':'quote"\\']))}
];
const results=[];
for(const profile of profiles){
  const raw=JSON.stringify({ph:'X',name:profile.name,pid:1,tid:1,ts:0,dur:1,args:profile.args}),batch=(','+raw).repeat(Math.max(1,Math.floor(1024*1024/(raw.length+1)))),rounds=64,samples=[];
  for(let run=0;run<3;run++){
    let events=0,characters=0;const reader=new TraceJSONReader((event,text)=>{events++;characters+=text.length;if(event.name!==profile.name)throw Error('wrong event');});const start=performance.now();reader.feed('['+raw);for(let i=0;i<rounds;i++)reader.feed(batch);reader.feed(']');reader.end();
    const ms=performance.now()-start,expected=1+rounds*batch.length/(raw.length+1);if(events!==expected||characters!==expected*raw.length)throw Error('lost source data');samples.push({ms,events,characters});
  }
  const inputBytes=Buffer.byteLength('['+raw)+rounds*Buffer.byteLength(batch)+1;
  results.push({profile:profile.name,inputBytes,corpusHash:crypto.createHash('sha256').update(raw).update(batch).update(String(rounds)).digest('hex'),samples,medianMs:[...samples.map(s=>s.ms)].sort((a,b)=>a-b)[1]});
}
const result={environment:'Node parser-only; three runs per synthetic corpus; one ~1 MiB batch retained, no disk index or rendered browser',node:process.version,source,sourceHash:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),results,createdAt:new Date().toISOString()};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
