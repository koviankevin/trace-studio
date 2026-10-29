import {TraceJSONReader,TraceIndex,demoTrace,LIMITS} from './core.js';
import {RelationIndex} from './relations.js';
import {summarizeGroups} from './track-layout.js';
import {hardwareDemo} from './hardware-demo.js';
let db,folder,rawHandle,indexHandle,relationHandle,relations,sessionId,source;
const send=(type,data={})=>postMessage({type,...data});
async function close(){for(const h of [rawHandle,indexHandle,relationHandle]){try{h?.close();}catch{}}rawHandle=indexHandle=relationHandle=null;db=null;}
async function root(){if(!navigator.storage?.getDirectory)throw Error('這個瀏覽器無法使用磁碟索引，請用最新版桌面 Chrome 或 Edge，並以 HTTPS 開啟。');return (await navigator.storage.getDirectory()).getDirectoryHandle('trace-studio-v1',{create:true});}
async function open(id,create){
  await close();folder=await(await root()).getDirectoryHandle(id,{create});sessionId=id;
  rawHandle=await(await folder.getFileHandle('events.bin',{create})).createSyncAccessHandle();
  try{indexHandle=await(await folder.getFileHandle('index.bin',{create})).createSyncAccessHandle();}
  catch(error){rawHandle.close();rawHandle=null;throw error;}
  db=new TraceIndex(rawHandle,indexHandle);
  relationHandle=await(await folder.getFileHandle('relations.bin',{create})).createSyncAccessHandle();
  relations=new RelationIndex(relationHandle,db);db.onEvent=(event,ref)=>relations.add(event,ref);
}
function publicInfo(m){
  const overview=Array(180).fill(0),duration=m.end-m.start;
  for(const b of m.blocks)for(const r of b.summary){const bin=Math.max(0,Math.min(179,Math.floor((r.ts-m.start)/duration*180)));overview[bin]+=r.n;}
  const {blocks,names,relations:links,...info}=m;info.top=info.top.map(r=>({...r,label:names[r.name]}));return {...info,relations:links?{count:links.count,bytes:links.bytes,types:links.types}:null,overview,id:sessionId,source,limits:LIMITS};
}
async function importFile(file,isDemo=false){
  const started=performance.now();
  const quota=await navigator.storage.estimate();
  const available=(quota.quota||0)-(quota.usage||0);
  if(!isDemo && !file.name.endsWith('.gz') && available<file.size*1.3)throw Error('瀏覽器剩餘儲存空間不足。請先清除舊快取或釋出磁碟空間後再匯入。');
  const id=crypto.randomUUID();await open(id,true);source={name:file.name,size:file.size,demo:isDemo};
  let read=0,lastReport=0,uncompressed=0;
  const reader=new TraceJSONReader((event,text)=>db.ingest(event,text),(key,value)=>db.addMetadata(key,value));
  let stream=file.stream().pipeThrough(new TransformStream({transform(chunk,controller){read+=chunk.byteLength;controller.enqueue(chunk);}}));
  if(file.name.endsWith('.gz'))stream=stream.pipeThrough(new DecompressionStream('gzip'));
  const chunks=stream.pipeThrough(new TextDecoderStream('utf-8',{fatal:true})).getReader();
  try{
    for(;;){const {value,done}=await chunks.read();if(done)break;uncompressed+=value.length;reader.feed(value);
      const now=performance.now();if(now-lastReport>100){lastReport=now;send('progress',{bytes:read,total:file.size,events:db.count,elapsed:(now-started)/1000,diskBytes:db.raw.offset+db.index.offset});}
    }
    reader.end();const manifest=db.finish();manifest.relations=relations.finish();manifest.source=source;manifest.importSeconds=(performance.now()-started)/1000;
    const writable=await(await folder.getFileHandle('manifest.json',{create:true})).createWritable();
    await writable.write(JSON.stringify(manifest));await writable.close();
    send('ready',{info:publicInfo(manifest)});
  }catch(error){await chunks.cancel().catch(()=>{});await close();await(await root()).removeEntry(id,{recursive:true}).catch(()=>{});throw error;}
}
onmessage=async({data})=>{
  const {type,requestId}=data;
  try{
    if(type==='import')await importFile(data.file);
    else if(type==='demo'){
      const file=new File([JSON.stringify(demoTrace())],'checkout-flow.demo.json',{type:'application/json'});await importFile(file,true);
    }else if(type==='hardwareDemo'){
      const file=new File([JSON.stringify(hardwareDemo())],'core-four-core.demo.json',{type:'application/json'});await importFile(file,true);
    }else if(type==='restore'){
      await open(data.id,false);const m=JSON.parse(await(await(await folder.getFileHandle('manifest.json')).getFile()).text());
      if(m.version!==1)throw Error('快取版本不相容，請重新開啟原始 trace。');
      db.restore(m);if(!m.relations)throw Error('關聯索引版本已更新，請重新匯入 trace。');relations.restore(m.relations);source=m.source;send('ready',{info:publicInfo(m),restored:true});
    }else if(type==='clear'){
      await close();const r=await root();for await(const name of r.keys())await r.removeEntry(name,{recursive:true});send('cleared');
    }else if(type==='query'&&db){const start=performance.now();send('query',{requestId,rows:db.query(data),groups:summarizeGroups(db,data.groups||[],data.start,data.end,data.width||1000),ms:performance.now()-start});}
    else if(type==='detail'&&db){const detail=db.detail(data.record);send('detail',{requestId,...detail,links:relations.find(detail.event,data.record)});}
    else if(type==='search'&&db){const result=await db.search(data.term,100,scanned=>send('searchProgress',{requestId,scanned}));send('search',{requestId,...result});}
    else if(type==='neighbor'&&db){
      send('neighbor',{requestId,record:db.neighbor(data.record,data.direction)});
    }else if(type==='benchmark'){
      // Generate a real File in OPFS without keeping the input in RAM; opt-in diagnostics only.
      const r=await root(),name=`bench-${crypto.randomUUID()}`;
      const handle=await r.getFileHandle(name,{create:true}),w=await handle.createWritable();
      const target=data.bytes||3_000_000_000;let written=0,events=0;
      await w.write('{"traceEvents":[');written+=16;
      const payload='x'.repeat(900);let batch='';
      while(written<target){batch+=`${events?',':''}{"name":"Task ${events%12}","ph":"X","pid":1,"tid":${events%8},"ts":${events*100},"dur":50,"cat":"benchmark","args":{"payload":"${payload}","index":${events}}}`;events++;
        if(batch.length>=1024*1024){await w.write(batch);written+=batch.length;batch='';send('benchmarkProgress',{bytes:written,total:target});}}
      if(batch)await w.write(batch);await w.write(']}');await w.close();
      const f=await handle.getFile();try{await importFile(new File([f],`synthetic-${f.size}.json`));}finally{await r.removeEntry(name).catch(()=>{});}
    }
  }catch(error){send('error',{requestId,operation:type,message:error.name==='QuotaExceededError'?'瀏覽器儲存額度不足。原始檔未變更；請清除快取或釋出空間再試。':error.message});}
};
