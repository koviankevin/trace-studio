import {TraceJSONReader,TraceIndex,demoTrace,LIMITS} from './core.js?v=0.3.2';
import {RelationIndex} from './relations.js';
import {summarizeGroups} from './track-layout.js?v=0.2.1';
import {hardwareDemo} from './hardware-demo.js';
import {analyzeTrace,scanTraceIndex} from './analysis.js';
import {loadExtensionHost} from './extensions/runtime.js';
import {createSessionStore} from './session-store.js?v=0.3.1';
// Register onmessage synchronously. A top-level await here drops messages
// delivered while custom.js is loading, including the UI's first import.
const extensionHostReady=loadExtensionHost();
let analysisToken=0;
let db,folder,rawHandle,indexHandle,relationHandle,relations,sessionId,source,sessionLease;
const send=(type,data={})=>postMessage({type,...data});
const sessions=createSessionStore(root,navigator.locks);
async function close(){analysisToken++;for(const h of [rawHandle,indexHandle,relationHandle]){try{h?.close();}catch{}}rawHandle=indexHandle=relationHandle=null;db=null;await sessionLease?.release();sessionLease=null;}
async function root(){if(!navigator.storage?.getDirectory)throw Error('這個瀏覽器無法使用磁碟索引，請用最新版桌面 Chrome 或 Edge，並以 HTTPS 開啟。');return (await navigator.storage.getDirectory()).getDirectoryHandle('trace-studio-v1',{create:true});}
async function open(id,create){
  await close();sessionLease=await sessions.lease(id);
  try{
    folder=await(await root()).getDirectoryHandle(id,{create});sessionId=id;
    rawHandle=await(await folder.getFileHandle('events.bin',{create})).createSyncAccessHandle();
    indexHandle=await(await folder.getFileHandle('index.bin',{create})).createSyncAccessHandle();
    db=new TraceIndex(rawHandle,indexHandle);
    relationHandle=await(await folder.getFileHandle('relations.bin',{create})).createSyncAccessHandle();
    relations=new RelationIndex(relationHandle,db);db.onEvent=(event,ref)=>relations.add(event,ref);
  }catch(error){await close();throw error;}
}
function publicInfo(m){
  const overview=Array(180).fill(0),duration=m.end-m.start;
  for(const b of m.blocks)for(const r of b.summary){const bin=Math.max(0,Math.min(179,Math.floor((r.ts-m.start)/duration*180)));overview[bin]+=r.n;}
  const {blocks,names,relations:links,...info}=m;info.top=info.top.map(r=>({...r,label:names[r.name]}));return {...info,relations:links?{count:links.count,bytes:links.bytes,types:links.types}:null,overview,id:sessionId,source,limits:LIMITS};
}
async function importFile(file,isDemo=false){
  const started=performance.now();
  const header=new Uint8Array(await file.slice(0,2).arrayBuffer()),gzip=header[0]===0x1f&&header[1]===0x8b;
  if(/\.gz$/i.test(file.name)&&!gzip)throw Error('檔名標示為 .gz，但內容不是 gzip。請確認檔案格式或重新匯出 JSON。');
  const quota=await navigator.storage?.estimate?.().catch(()=>({}))||{};
  const available=Number.isFinite(quota.quota)&&Number.isFinite(quota.usage)?Math.max(0,quota.quota-quota.usage):Infinity;
  if(!isDemo && !gzip && available<file.size*1.3)throw Error('瀏覽器剩餘儲存空間不足。請先清除舊快取或釋出磁碟空間後再匯入。');
  const id=crypto.randomUUID();let chunks;
  try{
    await open(id,true);source={name:file.name,size:file.size,demo:isDemo};const createdAt=new Date().toISOString();
    await sessions.write(folder,{source,createdAt});
    let read=0,lastReport=0;
    const reader=new TraceJSONReader((event,text)=>db.ingest(event,text),(key,value)=>db.addMetadata(key,value));
    let stream=file.stream().pipeThrough(new TransformStream({transform(chunk,controller){read+=chunk.byteLength;controller.enqueue(chunk);}}));
    if(gzip)stream=stream.pipeThrough(new DecompressionStream('gzip'));
    chunks=stream.pipeThrough(new TextDecoderStream('utf-8',{fatal:true})).getReader();
    for(;;){const {value,done}=await chunks.read();if(done)break;reader.feed(value);
      const now=performance.now();if(now-lastReport>100){lastReport=now;send('progress',{bytes:read,total:file.size,events:db.count,elapsed:(now-started)/1000,diskBytes:db.raw.offset+db.index.offset});}
    }
    reader.end();const manifest=db.finish();manifest.relations=relations.finish();manifest.source=source;manifest.createdAt=createdAt;manifest.importSeconds=(performance.now()-started)/1000;
    const writable=await(await folder.getFileHandle('manifest.json',{create:true})).createWritable();
    await writable.write(JSON.stringify(manifest));await writable.close();
    await sessions.write(folder,{source,createdAt,count:manifest.count});
    send('ready',{info:publicInfo(manifest)});
  }catch(error){await chunks?.cancel().catch(()=>{});await close();try{await(await root()).removeEntry(id,{recursive:true});}catch{}throw error;}
}
onmessage=async({data})=>{
  const {type,requestId}=data;
  try{
    const extensionHost=await extensionHostReady;
    if(type==='import')await importFile(data.file);
    else if(type==='demo'){
      const file=new File([JSON.stringify(demoTrace())],'checkout-flow.demo.json',{type:'application/json'});await importFile(file,true);
    }else if(type==='hardwareDemo'){
      const file=new File([JSON.stringify(hardwareDemo())],'core-four-core.demo.json',{type:'application/json'});await importFile(file,true);
    }else if(type==='restore'){
      await open(data.id,false);const m=JSON.parse(await(await(await folder.getFileHandle('manifest.json')).getFile()).text());
      if(m.version!==1)throw Error('快取版本不相容，請重新開啟原始 trace。');
      db.restore(m);if(!m.relations)throw Error('關聯索引版本已更新，請重新匯入 trace。');relations.restore(m.relations);source=m.source;send('ready',{info:publicInfo(m),restored:true});
    }else if(type==='sessions'){send('sessions',{requestId,sessions:await sessions.list(db?sessionId:null)});
    }else if(type==='removeSession'){
      if(db&&data.id===sessionId)throw Error('請先關閉目前的 Trace，或使用「清除全部未鎖定快取」。');
      send('sessionRemoved',{requestId,...await sessions.remove(data.id),sessions:await sessions.list(db?sessionId:null)});
    }else if(type==='clearUnused'){
      const result=await sessions.clear({keep:db?[sessionId]:[]});send('unusedCleared',{requestId,...result,sessions:await sessions.list(db?sessionId:null)});
    }else if(type==='clear'){
      await close();const result=await sessions.clear();sessionId=null;send('cleared',result);
    }else if(type==='query'&&db){const start=performance.now();send('query',{requestId,rows:db.query(data),groups:summarizeGroups(db,data.groups||[],data.start,data.end,data.width||1000),ms:performance.now()-start});}
    else if(type==='analysis'&&db){const token=++analysisToken,current=db,cancelled=()=>analysisToken!==token||db!==current;
      const result=await analyzeTrace(current,{...data,cancelled,onProgress:progress=>send('analysisProgress',{requestId,...progress})});
      result.extensions=await extensionHost.analyze({summary:result,scope:result.scope,cancelled,scanIndex:()=>scanTraceIndex(current,{...result.scope,cancelled}),readEvent:record=>current.detail(record).event});result.extensionErrors=extensionHost.startupErrors||[];
      if(cancelled()){const error=new Error('分析已取消');error.name='AbortError';throw error;}send('analysis',{requestId,result});}
    else if(type==='cancelAnalysis'){analysisToken++;}
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
  }catch(error){if(type==='analysis'&&error.name==='AbortError')send('analysisCancelled',{requestId});else send('error',{requestId,operation:type,code:error.name,message:error.name==='QuotaExceededError'?'瀏覽器儲存額度不足。原始檔未變更；請清除快取或釋出空間再試。':error.name==='NoModificationAllowedError'?'這份 Trace 正由其他分頁或背景作業使用，請關閉該分頁後重試。':error.message});}
};
