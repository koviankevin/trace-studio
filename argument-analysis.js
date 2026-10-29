import {scanTraceIndex} from './analysis.js?v=0.4.0';
import {extractRecordFacts,compareMemory} from './argument-facts.js?v=0.4.0';

// On-demand raw-argument analysis. It never runs on import or viewport queries.
export async function analyzeArguments(trace,{start=trace.start,end=trace.end,trackIds=trace.tracks.map(t=>t.id),focus=null,maxGroups=16384,memberOffset=0,timeBudgetMs=8,onProgress=()=>{},cancelled=()=>false,yieldNow=()=>new Promise(resolve=>setTimeout(resolve,0))}={}){
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error('請選擇有效的事件欄位分析範圍');
  if(!Number.isInteger(memberOffset)||memberOffset<0||!Number.isInteger(maxGroups)||maxGroups<1||maxGroups>65536)throw Error('事件欄位分析的頁次或群組上限無效');
  if(!Number.isFinite(timeBudgetMs)||timeBudgetMs<0||timeBudgetMs>50)throw Error('事件欄位分析的執行時間預算無效');
  const groups={tflite:new Map(),flow:new Map()},locations=new Map(),names=new Map(),members=[],selected=new Set(trackIds),counterOwners=new Map();let omittedNameEvents=0;
  for(const track of trace.tracks)if(selected.has(track.id)&&track.kind==='counter'&&track.counterSource!==undefined){const key=JSON.stringify([track.pid,track.tid,track.counterSource]);if(!counterOwners.has(key))counterOwners.set(key,new Map());counterOwners.get(key).set(track.counterKey,track.id);}
  let scanned=0,events=0,withIds=0,memoryRanges=0,matched=0,truncatedFacts=0,conflicts=0,warnings=0,omittedGroupEvents=0,omittedLocationRanges=0,lastYield=performance.now(),lastProgress=0;
  const started=performance.now(),total=trackIds.reduce((sum,id)=>sum+(trace.tracks[id]?.count||0),0);
  const abort=()=>{if(cancelled()){const error=Error('分析已取消');error.name='AbortError';throw error;}};
  function stat(map,key){if(map.has(key))return map.get(key);if(map.size>=maxGroups){omittedGroupEvents++;return null;}const value={id:key,count:0,totalUs:0,start:Infinity,end:-Infinity,cores:new Set(),pids:new Set(),memories:0,examples:[]};map.set(key,value);return value;}
  function add(group,record,facts){if(!group)return;group.count++;group.totalUs+=Math.max(0,Math.min(end,record.ts+record.dur)-Math.max(start,record.ts));group.start=Math.min(group.start,Math.max(start,record.ts));group.end=Math.max(group.end,Math.min(end,record.ts+record.dur));group.memories+=facts.memories.length;if(group.cores.size<64&&facts.ids.core!==undefined)group.cores.add(facts.ids.core);if(group.pids.size<64)group.pids.add(String(trace.tracks[record.trackId].pid));if(group.examples.length<3)group.examples.push(record);}
  for await(const source of scanTraceIndex(trace,{start,end,trackIds,cancelled})){
    abort();scanned++;const track=trace.tracks[source.trackId];
    // Pick an owner from metrics actually present in this raw C event. Metrics
    // may appear/disappear between samples; a fixed track owner would lose them.
    const detail=trace.detail(source);
    if(source.kind===2&&track.counterSource!==undefined){const owners=counterOwners.get(JSON.stringify([track.pid,track.tid,track.counterSource]));const key=Object.keys(detail.event.args||{}).find(key=>Number.isFinite(detail.event.args[key])&&owners.has(key));if(owners.get(key)!==track.id)continue;}
    if(source.kind===2&&track.counterSource===undefined){const keys=Object.keys(detail.event.args||{}).filter(key=>Number.isFinite(detail.event.args[key]));let owner;for(const key of keys){owner=trace.tracks.find(t=>selected.has(t.id)&&t.kind==='counter'&&t.pid===track.pid&&t.tid===track.tid&&[String(detail.event.name??'未命名事件'),'undefined','null','未命名事件'].some(name=>t.key===`${track.pid}/${track.tid}/${name} · ${key}`));if(owner)break;}if(owner&&owner.id!==track.id)continue;}
    const facts=extractRecordFacts(detail),record={...source,label:trace.displayName?trace.displayName(source,source.trackId,detail.event):source.label};events++;if(Object.keys(facts.ids).length)withIds++;if(facts.truncated)truncatedFacts++;conflicts+=facts.conflicts.length;warnings+=facts.warnings.length;
    let matches=[];
    if(focus?.kind==='tflite'||focus?.kind==='flow'){if(facts.ids[focus.kind]===String(focus.value))matches=[{kind:'same-id',path:facts.sources[focus.kind]}];}
    else if(focus?.kind==='memory'&&record.offset!==focus.sourceOffset){
      const sameProcess=String(track.pid)===String(focus.pid),sameCore=focus.core===undefined||facts.ids.core===undefined||focus.core===facts.ids.core;
      if(focus.crossProcess||sameProcess&&sameCore)for(const target of focus.memories||[])for(const memory of facts.memories){const match=compareMemory(target,memory);if(match&&matches.length<16)matches.push({...match,location:memory.location,path:memory.path,basis:memory.basis,order:focus.ts===undefined?'unknown':record.ts+record.dur<=focus.ts?'before':record.ts>=focus.ts+(focus.dur||0)?'after':'overlap-time'});}
    }
    if(!focus||matches.length){
    if(focus){if(!names.has(record.label)&&names.size<4096)names.set(record.label,{label:record.label,count:0,totalUs:0,maxUs:0});const entry=names.get(record.label),duration=Math.max(0,Math.min(end,record.ts+record.dur)-Math.max(start,record.ts));if(entry){entry.count++;entry.totalUs+=duration;entry.maxUs=Math.max(entry.maxUs,duration);}else omittedNameEvents++;}
    for(const kind of ['tflite','flow'])if(facts.ids[kind]!==undefined)add(stat(groups[kind],facts.ids[kind]),record,facts);
    for(const memory of facts.memories){memoryRanges++;const key=JSON.stringify([track.pid,facts.ids.core??'',memory.space]);if(!locations.has(key)&&locations.size<4096)locations.set(key,{pid:track.pid,core:facts.ids.core??'',space:memory.space,count:0,inputs:0,outputs:0,declaredBytes:0n,sizeMismatches:0});const entry=locations.get(key);if(entry){entry.count++;if(memory.role==='input')entry.inputs++;if(memory.role==='output')entry.outputs++;if(memory.declaredBytes!==null)entry.declaredBytes+=BigInt(memory.declaredBytes);if(memory.sizeMatches===false)entry.sizeMismatches++;}else omittedLocationRanges++;}
    }
    if(matches.length){if(matched>=memberOffset&&members.length<100)members.push({record,pid:track.pid,tid:track.tid,core:facts.ids.core??null,ids:facts.ids,memories:facts.memories,matches});matched++;}
    const now=performance.now();if(now-lastProgress>100){lastProgress=now;onProgress({stage:'args',focused:!!focus,scanned,total,events,matched,elapsed:(now-started)/1000});}
    if(now-lastYield>=timeBudgetMs){await yieldNow();lastYield=performance.now();abort();}
  }
  abort();const finish=map=>[...map.values()].map(group=>({...group,cores:[...group.cores],pids:[...group.pids]})).sort((a,b)=>b.totalUs-a.totalUs||b.count-a.count).slice(0,100);
  onProgress({stage:'args',focused:!!focus,scanned,total,events,matched,elapsed:(performance.now()-started)/1000});
  return {scope:{start,end,trackIds},focus,nameCount:names.size,byName:[...names.values()].sort((a,b)=>b.totalUs-a.totalUs).slice(0,100),omittedNameEvents,scanned,events,withIds,memoryRanges,groups:{tflite:finish(groups.tflite),flow:finish(groups.flow)},locations:[...locations.values()].map(entry=>({...entry,declaredBytes:String(entry.declaredBytes)})),matched,members,memberOffset,hasMore:matched>memberOffset+members.length,truncatedFacts,conflicts,warnings,omittedGroupEvents,omittedLocationRanges,analysisSeconds:(performance.now()-started)/1000,notes:['同 ID 是事件集合，不代表唯一一次推論或已證明的因果鏈。','時間累計包含巢狀及重疊；宣告記憶體大小累計可能包含重用，不是實際傳輸量。','位址對應是同範圍／重疊候選；須連同程序、核心、Location 與時間核對。','每類最多 16,384 個群組，顯示前 100 組；指定 ID 比對仍掃描完整選取範圍。']};
}
