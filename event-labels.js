// Display policy only. Source names and IDs in raw JSON are never changed.
export function shortTid(tid,pid,processName){
  const original=String(tid??0);let result=original;
  for(const prefix of [...new Set([String(pid??''),String(processName??'')])].filter(Boolean).sort((a,b)=>b.length-a.length)){
    if(result.startsWith(prefix)&&/^[\s_:/.-]/.test(result.slice(prefix.length)))result=result.slice(prefix.length).replace(/^[\s_:/.-]+/,'');
  }
  return result||original;
}
export function missingEventName(event){return event.name===null||event.name===undefined||!String(event.name).trim();}
export function fallbackEventName(event,track={},processes={}){return shortTid(event.tid??track.tid,event.pid??track.pid,processes[event.pid??track.pid]);}
