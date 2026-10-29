import {TraceJSONReader,TraceIndex,demoTrace,LIMITS} from './core.js?v=0.4.0';
import {RelationIndex} from './relations.js?v=0.7.0';
import {summarizeGroups} from './track-layout.js?v=0.4.0';
import {hardwareDemo} from './hardware-demo.js?v=0.4.0';
import {analyzeTrace,scanTraceIndex} from './analysis.js?v=0.4.0';
import {loadExtensionHost} from './extensions/runtime.js';
import {createSessionStore} from './session-store.js?v=0.3.1';
import {extractRecordFacts} from './argument-facts.js?v=0.4.0';
import {analyzeArguments} from './argument-analysis.js?v=0.7.0';
import {TraceCache} from './trace-cache.js?v=0.5.0';
import {compareTraces} from './trace-comparison.js?v=0.7.0';
import {readTar} from './tar-stream.js?v=0.7.0';
// Register onmessage synchronously. A top-level await here drops messages
// delivered while custom.js is loading, including the UI's first import.
const extensionHostReady=loadExtensionHost();
let analysisToken=0;
let importOperation=null;
const abortImport=operation=>{if(operation?.cancelled)throw Object.assign(Error('已取消開檔'),{name:'AbortError'});};
const argumentCache=new Map();
let db,folder,rawHandle,indexHandle,relationHandle,relations,sessionId,source,sessionLease,activeManifest;
const traceCache=new TraceCache();
const send=(type,data={})=>postMessage({type,...data});
const sessions=createSessionStore(root,navigator.locks);
const context=()=>({db,folder,rawHandle,indexHandle,relationHandle,relations,sessionId,source,sessionLease,activeManifest});
function activate(value){({db,folder,rawHandle,indexHandle,relationHandle,relations,sessionId,source,sessionLease,activeManifest}=value);}
async function dispose(value){for(const handle of [value?.rawHandle,value?.indexHandle,value?.relationHandle]){try{handle?.close();}catch{}}await value?.sessionLease?.release();}
async function drainCache(){for(const value of traceCache.drain())await dispose(value);}
async function close({retain=false}={}){analysisToken++;argumentCache.clear();const previous=context();rawHandle=indexHandle=relationHandle=sessionLease=activeManifest=null;db=null;if(retain&&previous.db&&previous.activeManifest){for(const value of traceCache.put(previous))await dispose(value);}else await dispose(previous);}
async function root(){if(!navigator.storage?.getDirectory)throw Error('這個瀏覽器無法使用磁碟索引，請用最新版桌面 Chrome 或 Edge，並以 HTTPS 開啟。');return (await navigator.storage.getDirectory()).getDirectoryHandle('trace-studio-v1',{create:true});}
async function open(id,create){
  // Reserve the requested index before parking the current one can evict it.
  let cached=!create&&traceCache.take(id);try{await close({retain:true});}catch(error){await dispose(cached);throw error;}cached||=!create&&traceCache.take(id);if(cached){activate(cached);return true;}sessionLease=await sessions.lease(id);
  try{
    folder=await(await root()).getDirectoryHandle(id,{create});sessionId=id;
    rawHandle=await(await folder.getFileHandle('events.bin',{create})).createSyncAccessHandle();
    indexHandle=await(await folder.getFileHandle('index.bin',{create})).createSyncAccessHandle();
    db=new TraceIndex(rawHandle,indexHandle);
    relationHandle=await(await folder.getFileHandle('relations.bin',{create})).createSyncAccessHandle();
    relations=new RelationIndex(relationHandle,db);db.onEvent=(event,ref)=>relations.add(event,ref);
  }catch(error){await close();throw error;}
}
async function comparisonTrace(id){
  if(db&&id===sessionId)return {trace:db,source,release:async()=>{}};
  const cached=traceCache.peek(id);if(cached)return {trace:cached.db,source:cached.source,release:async()=>{}};
  const lease=await sessions.lease(id),handles=[];try{
    const directory=await(await root()).getDirectoryHandle(id),manifest=JSON.parse(await(await(await directory.getFileHandle('manifest.json')).getFile()).text());
    if(manifest.version!==1)throw Error('比較資料快取版本不相容，請重新匯入原檔。');
    for(const name of ['events.bin','index.bin'])handles.push(await(await directory.getFileHandle(name)).createSyncAccessHandle());
    return {trace:new TraceIndex(...handles).restore(manifest),source:manifest.source,release:async()=>{for(const handle of handles)handle.close();await lease.release();}};
  }catch(error){for(const handle of handles){try{handle.close();}catch{}}await lease.release();throw error;}
}
function publicInfo(m){
  const overview=Array(180).fill(0),duration=m.end-m.start;
  for(const b of m.blocks)for(const r of b.summary){const bin=Math.max(0,Math.min(179,Math.floor((r.ts-m.start)/duration*180)));overview[bin]+=r.n;}
  const {blocks,names,relations:links,...info}=m;info.top=info.top.map(r=>({...r,label:db.displayName(r,r.trackId)}));return {...info,relations:links?{count:links.count,bytes:links.bytes,types:links.types}:null,overview,id:sessionId,source,limits:LIMITS};
}
async function restoreSession(id){
  const memoryRestored=await open(id,false),manifest=memoryRestored?activeManifest:JSON.parse(await(await(await folder.getFileHandle('manifest.json')).getFile()).text());
  if(manifest.version!==1)throw Error('快取版本不相容，請重新開啟原始 trace。');
  if(!manifest.relations)throw Error('關聯索引版本已更新，請重新匯入 trace。');
  if(!memoryRestored){db.restore(manifest);relations.restore(manifest.relations);}source=manifest.source;activeManifest=manifest;return {manifest,memoryRestored:!!memoryRestored};
}
async function checkQuota(size){
  const quota=await navigator.storage?.estimate?.().catch(()=>({}))||{};
  const available=Number.isFinite(quota.quota)&&Number.isFinite(quota.usage)?Math.max(0,quota.quota-quota.usage):Infinity;
  if(available<size*1.3)throw Error('瀏覽器剩餘儲存空間不足。請先清除舊快取或釋出磁碟空間後再匯入。');
}
async function saveManifest(manifest){const writer=await(await folder.getFileHandle('manifest.json',{create:true})).createWritable();try{await writer.write(JSON.stringify(manifest));await writer.close();}catch(error){await writer.abort?.().catch(()=>{});throw error;}}
async function importJSONStream(stream,sourceInfo,{started=performance.now(),progressStarted=started,progress=()=>({bytes:sourceInfo.size,total:sourceInfo.size}),knownSize=true,operation=null}={}){
  try{abortImport(operation);if(knownSize&&!sourceInfo.demo)await checkQuota(sourceInfo.size);abortImport(operation);}catch(error){await stream.cancel().catch(()=>{});throw error;}
  const id=crypto.randomUUID();let chunks;
  try{
    await open(id,true);abortImport(operation);source=sourceInfo;const createdAt=new Date().toISOString();
    await sessions.write(folder,{source,createdAt});
    let lastReport=0;
    const reader=new TraceJSONReader((event,text)=>db.ingest(event,text),(key,value)=>db.addMetadata(key,value));
    chunks=stream.pipeThrough(new TextDecoderStream('utf-8',{fatal:true})).getReader();
    for(;;){abortImport(operation);const {value,done}=await chunks.read();abortImport(operation);if(done)break;reader.feed(value);
      const now=performance.now();if(now-lastReport>100){lastReport=now;send('progress',{...progress(),events:db.count,elapsed:(now-progressStarted)/1000,diskBytes:db.raw.offset+db.index.offset});}
    }
    abortImport(operation);reader.end();const manifest=db.finish();manifest.relations=relations.finish();manifest.source=source;manifest.createdAt=createdAt;manifest.importSeconds=(performance.now()-started)/1000;
    await saveManifest(manifest);
    await sessions.write(folder,{source,createdAt,count:manifest.count});
    abortImport(operation);
    activeManifest=manifest;return manifest;
  }catch(error){
    // Request upstream cancellation before releasing the file handles. A browser
    // File/decoder pipe may settle cancellation later; do not hold the OPFS lease
    // while waiting for a stream which will no longer be consumed.
    if(chunks)chunks.cancel().catch(()=>{});else stream.cancel().catch(()=>{});
    if(error.name==='AbortError')send('importCleanup',{stage:'closing'});
    await close();if(error.name==='AbortError')send('importCleanup',{stage:'removing'});
    try{await(await root()).removeEntry(id,{recursive:true});}catch{}throw error;
  }finally{chunks?.releaseLock();}
}
async function runImport(file,isDemo=false,requestId){
  if(importOperation)throw Error('已有檔案正在開啟，請先完成或取消。');const operation={cancelled:false};importOperation=operation;try{await importFile(file,isDemo,requestId,operation);}finally{if(importOperation===operation)importOperation=null;}
}
async function importFile(file,isDemo=false,requestId,operation=null){
  const started=performance.now(),header=new Uint8Array(await file.slice(0,2).arrayBuffer()),gzip=header[0]===0x1f&&header[1]===0x8b,archive=/\.(?:tar(?:\.gz)?|tgz)$/i.test(file.name);
  abortImport(operation);
  if(/\.(?:gz|tgz)$/i.test(file.name)&&!gzip)throw Error('檔名標示為 gzip，但內容不是 gzip。請確認檔案格式。');
  let read=0,stream=file.stream().pipeThrough(new TransformStream({transform(chunk,controller){read+=chunk.byteLength;controller.enqueue(chunk);}}));if(gzip)stream=stream.pipeThrough(new DecompressionStream('gzip'));
  const progress=()=>({bytes:read,total:file.size});
  if(!archive){const manifest=await importJSONStream(stream,{name:file.name,size:file.size,demo:isDemo},{started,progress,knownSize:!gzip,operation});send('ready',{requestId,info:publicInfo(manifest)});return;}
  const summary={name:file.name,imported:0,skipped:0,failed:0,complete:true,failures:[]};let lastId=null;
  try{await readTar(stream,{cancelled:()=>!!operation?.cancelled,onSkip:()=>summary.skipped++,onFile:async(entry,body)=>{
    if(!/\.json(?:\.gz)?$/i.test(entry.name)){summary.skipped++;return;}
    if(summary.imported+summary.failed>=256)throw Error('單一 tar 最多匯入 256 個 JSON 成員');
    send('progress',{...progress(),member:entry.name,events:0,elapsed:(performance.now()-started)/1000});
    try{const nestedGzip=/\.gz$/i.test(entry.name);await importJSONStream(nestedGzip?body.pipeThrough(new DecompressionStream('gzip')):body,{name:`${file.name} › ${entry.name}`,size:entry.size,demo:false,archive:{name:file.name,path:entry.name}},{progress:()=>({...progress(),member:entry.name}),progressStarted:started,knownSize:!nestedGzip,operation});lastId=sessionId;summary.imported++;}
    catch(error){if(error.name==='AbortError')throw error;summary.failed++;if(summary.failures.length<20)summary.failures.push({name:entry.name,message:error.message});if(error.name==='QuotaExceededError'||/儲存空間不足/.test(error.message))throw error;}
  }});}catch(error){if(error.name==='AbortError'||operation?.cancelled)throw Object.assign(error,{name:'AbortError'});summary.complete=false;summary.error=error.message;}
  if(!lastId)throw Error(summary.error||`封裝內沒有可讀的 Trace JSON（${summary.failed} 份失敗、${summary.skipped} 份略過）。`);
  if(!db||sessionId!==lastId||!activeManifest)await restoreSession(lastId);
  summary.elapsed=(performance.now()-started)/1000;db.addMetadata('archiveImport',summary);try{await saveManifest(activeManifest);}catch(error){summary.saveWarning=error.message;}
  send('ready',{requestId,info:publicInfo(activeManifest),archive:summary});
}
onmessage=async({data})=>{
  const {type,requestId}=data;
  // Keep the originating trace identity even if an async response finishes later.
  const send=(type,payload={})=>postMessage({type,...(data.traceId?{traceId:data.traceId}:{}),...payload});
  try{
    const extensionHost=await extensionHostReady;
    if(data.traceId&&data.traceId!==sessionId)throw Error('請求所屬 Trace 已切換。');
    if(type==='cancelImport'){if(importOperation)importOperation.cancelled=true;else send('importCancelUnavailable',{requestId});}
    else if(type==='import')await runImport(data.file,false,requestId);
    else if(type==='demo'){
      const file=new File([JSON.stringify(demoTrace())],'checkout-flow.demo.json',{type:'application/json'});await runImport(file,true,requestId);
    }else if(type==='hardwareDemo'){
      const file=new File([JSON.stringify(hardwareDemo())],'core-four-core.demo.json',{type:'application/json'});await runImport(file,true,requestId);
    }else if(type==='restore'){
      const {manifest,memoryRestored}=await restoreSession(data.id);send('ready',{requestId,info:publicInfo(manifest),restored:true,memoryRestored});
    }else if(type==='cachePolicy'){analysisToken++;for(const value of traceCache.configure(data.limitMB))await dispose(value);send('cachePolicy',{requestId,limitMB:data.limitMB});
    }else if(type==='sessions'){send('sessions',{requestId,sessions:(await sessions.list(db?sessionId:null)).map(item=>({...item,memory:traceCache.has(item.id)||item.current}))});
    }else if(type==='removeSession'){
      if(db&&data.id===sessionId)throw Error('請先關閉目前的 Trace，或使用「清除全部未鎖定快取」。');
      if(traceCache.has(data.id)){analysisToken++;await dispose(traceCache.take(data.id));}
      send('sessionRemoved',{requestId,...await sessions.remove(data.id),sessions:await sessions.list(db?sessionId:null)});
    }else if(type==='clearUnused'){analysisToken++;
      await drainCache();
      const result=await sessions.clear({keep:db?[sessionId]:[]});send('unusedCleared',{requestId,...result,sessions:await sessions.list(db?sessionId:null)});
    }else if(type==='clear'){
      await close();await drainCache();const result=await sessions.clear();sessionId=null;send('cleared',result);
    }else if(type==='query'&&db){const start=performance.now();send('query',{requestId,rows:db.query(data),groups:summarizeGroups(db,data.groups||[],data.start,data.end,data.width||1000),ms:performance.now()-start});}
    else if(type==='analysis'&&db){const started=performance.now(),token=++analysisToken,current=db,cancelled=()=>analysisToken!==token||db!==current;
      const result=await analyzeTrace(current,{...data,cancelled,onProgress:progress=>send('analysisProgress',{requestId,...progress})});
      if(data.includeArguments){const key=JSON.stringify([result.scope.start,result.scope.end,result.scope.trackIds,data.argumentFocus||null,data.memberOffset||0]);if(argumentCache.has(key))result.arguments={...argumentCache.get(key),reused:true};else{result.arguments=await analyzeArguments(current,{...result.scope,focus:data.argumentFocus,memberOffset:data.memberOffset||0,cancelled,onProgress:progress=>send('analysisProgress',{requestId,...progress})});argumentCache.set(key,result.arguments);if(argumentCache.size>8)argumentCache.delete(argumentCache.keys().next().value);}}
      result.extensions=await extensionHost.analyze({summary:result,scope:result.scope,cancelled,scanIndex:()=>scanTraceIndex(current,{...result.scope,cancelled}),readEvent:record=>current.detail(record).event});result.extensionErrors=extensionHost.startupErrors||[];
      if(cancelled()){const error=new Error('分析已取消');error.name='AbortError';throw error;}result.analysisSeconds=(performance.now()-started)/1000;send('analysis',{requestId,result});}
    else if(type==='compare'){const token=++analysisToken,cancelled=()=>analysisToken!==token;const result=await compareTraces(data.ids,data.tfliteId,{openTrace:comparisonTrace,scopes:data.scopes,sourceNames:data.sourceNames,cancelled,onProgress:progress=>send('comparisonProgress',{requestId,...progress})});send('comparison',{requestId,result});}
    else if(type==='cancelAnalysis'){analysisToken++;}
    else if(type==='detail'&&db){const detail=db.detail(data.record);send('detail',{requestId,...detail,facts:extractRecordFacts(detail),links:relations.find(detail.event,data.record)});}
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
  }catch(error){if(['import','demo','hardwareDemo'].includes(type)&&error.name==='AbortError')send('importCancelled',{requestId});else if(['analysis','compare'].includes(type)&&error.name==='AbortError')send(type==='compare'?'comparisonCancelled':'analysisCancelled',{requestId});else send('error',{requestId,operation:type,code:error.name,message:error.name==='QuotaExceededError'?'瀏覽器儲存額度不足。原始檔未變更；請清除快取或釋出空間再試。':error.name==='NoModificationAllowedError'?'這份 Trace 正由其他分頁或背景作業使用，請關閉該分頁後重試。':error.message});}
};
