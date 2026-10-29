// OPFS session lifecycle. Never reads raw event files into memory.
const VALID_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILES=['events.bin','index.bin','relations.bin','manifest.json','session.json'];
const lockName=id=>`trace-studio-v1:session:${id}`;
function validate(id){if(typeof id!=='string'||!VALID_ID.test(id))throw Error('無效的 Trace 快取識別碼');}
export function createSessionStore(getRoot,locks){
  async function lease(id){
    validate(id);
    if(!locks?.request)return {release:async()=>{}};
    let resolveReady,release;
    const ready=new Promise(resolve=>resolveReady=resolve),held=new Promise(resolve=>release=resolve);
    const finished=locks.request(lockName(id),{ifAvailable:true},async lock=>{
      if(!lock){resolveReady(null);return;}
      resolveReady({release:async()=>{release();await finished;}});await held;
    });
    finished.catch(error=>resolveReady({error}));
    const result=await ready;if(result?.error)throw result.error;
    if(!result){const error=Error('這份 Trace 正由其他分頁使用。請關閉該分頁後重試，或開啟另一份原始檔。');error.name='SessionBusyError';throw error;}
    return result;
  }
  async function file(directory,name){try{return await(await directory.getFileHandle(name)).getFile();}catch(error){if(error.name==='NotFoundError'||error.code==='ENOENT'||error.message==='not found')return null;throw error;}}
  async function brief(directory){
    const light=await file(directory,'session.json');
    if(light&&light.size<=64*1024){try{const info=JSON.parse(await light.text());if(info&&typeof info==='object'&&!Array.isArray(info))return info;}catch{}}
    const legacy=await file(directory,'manifest.json');
    // Legacy manifests may contain millions of index summaries. Bound reads.
    if(legacy&&legacy.size<=256*1024){try{const m=JSON.parse(await legacy.text());return {source:m.source,createdAt:m.createdAt,count:m.count};}catch{}}
    return {};
  }
  async function list(currentId=null){
    const root=await getRoot(),result=[];
    for await(const id of root.keys()){
      if(!VALID_ID.test(id))continue;
      try{
        const directory=await root.getDirectoryHandle(id),info=await brief(directory);let bytes=0,complete=false;
        for(const name of FILES){const entry=await file(directory,name);if(entry){bytes+=entry.size;if(name==='manifest.json')complete=entry.size>0;}}
        let busy=id===currentId;
        if(!busy&&locks?.request){try{const held=await lease(id);await held.release();}catch(error){if(error.name==='SessionBusyError')busy=true;else throw error;}}
        const createdAt=typeof info.createdAt==='string'&&Number.isFinite(Date.parse(info.createdAt))?new Date(info.createdAt).toISOString():null;
        result.push({id,name:String(info.source?.name||`舊版或未完成 Trace · ${id.slice(0,8)}`).slice(0,400),demo:!!info.source?.demo,createdAt,count:Number.isSafeInteger(info.count)&&info.count>=0?info.count:null,bytes,complete,current:id===currentId,busy});
      }catch(error){if(error.name!=='NotFoundError'&&error.code!=='ENOENT')result.push({id,name:'無法讀取的 Trace 快取',bytes:0,current:id===currentId,busy:true,complete:false});}
    }
    return result.sort((a,b)=>Number(b.current)-Number(a.current)||(b.createdAt||'').localeCompare(a.createdAt||'')||a.id.localeCompare(b.id));
  }
  async function remove(id){
    validate(id);let held;
    try{
      held=await lease(id);
      const root=await getRoot(),directory=await root.getDirectoryHandle(id);
      // Without cooperative locks, avoid deleting an import which may just
      // have created its folder and not yet acquired OPFS file locks.
      if(!locks?.request&&!await file(directory,'manifest.json'))return {id,removed:false,reason:'unsupported'};
      // Older app versions do not hold a cooperative lease. They acquire the
      // events.bin exclusive handle first and keep it until the session closes.
      // Remove that one file first: a busy-file rejection must occur before a
      // recursive removal, which can otherwise fail after deleting metadata.
      if(await file(directory,'events.bin'))await directory.removeEntry('events.bin');
      else if(!await file(directory,'manifest.json'))return {id,removed:false,reason:'unsupported'};
      await root.removeEntry(id,{recursive:true});return {id,removed:true};
    }catch(error){
      if(error.name==='NotFoundError'||error.code==='ENOENT')return {id,removed:true,missing:true};
      return {id,removed:false,reason:['SessionBusyError','NoModificationAllowedError','InvalidStateError'].includes(error.name)?'busy':'error',message:error.message};
    }finally{await held?.release();}
  }
  async function clear({keep=[]}={}){
    const preserve=new Set(keep),removed=[],skipped=[];
    for(const session of await list()){
      if(preserve.has(session.id)){skipped.push({id:session.id,reason:'current'});continue;}
      const result=await remove(session.id);if(result.removed)removed.push(session.id);else skipped.push(result);
    }
    return {removed,skipped};
  }
  async function write(directory,info){
    const writer=await(await directory.getFileHandle('session.json',{create:true})).createWritable();
    try{await writer.write(JSON.stringify(info));await writer.close();}catch(error){await writer.abort?.().catch(()=>{});throw error;}
  }
  return {lease,list,remove,clear,write};
}
