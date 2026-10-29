import {LIMITS} from './core.js?v=0.9.0';
// Read only the fixed-width index. Raw args stay on disk until an event is selected.
const STEP=LIMITS.recordBytes;
function reference(v,o,trackId,names){return {ts:v.getFloat64(o,true),dur:v.getFloat64(o+8,true),offset:v.getFloat64(o+16,true),length:v.getUint32(o+24,true),name:v.getUint32(o+28,true),endOffset:v.getFloat64(o+32,true),endLength:v.getUint32(o+40,true),depth:v.getUint32(o+44,true),color:v.getUint32(o+48,true),kind:v.getUint32(o+52,true),value:v.getFloat64(o+56,true),trackId,label:names[v.getUint32(o+28,true)]};}
export async function* scanTraceIndex(trace,{start=trace.start,end=trace.end,trackIds=trace.tracks.map(t=>t.id),cancelled=()=>false}={}){
  let batches=0;for(const id of [...new Set(trackIds)]){const t=trace.tracks[id];if(!t)continue;for(const bi of t.blocks){
    if(cancelled()){const error=new Error('分析已取消');error.name='AbortError';throw error;}
    const b=trace.blocks[bi];if(b.start>=end||b.end<start)continue;const v=trace.readBlock(b);
    for(let i=0;i<b.count;i++){const o=i*STEP,ts=v.getFloat64(o,true),dur=v.getFloat64(o+8,true);if(ts>=end||ts+dur<start||dur>0&&ts+dur<=start)continue;yield reference(v,o,id,trace.names);}
    if(++batches%8===0)await new Promise(r=>setTimeout(r,0));
  }}
}
export async function analyzeTrace(trace,{start=trace.start,end=trace.end,trackIds=trace.tracks.map(t=>t.id),thresholdUs=1000,onProgress=()=>{},cancelled=()=>false,yieldNow=()=>new Promise(r=>setTimeout(r,0))}={}){
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error('請選擇有效的分析時間範圍');
  if(!Number.isFinite(thresholdUs)||thresholdUs<0)throw Error('長事件門檻必須是非負數');
  const ids=[...new Set(trackIds)].filter(id=>trace.tracks[id]),names=trace.names;
  const counts=new Float64Array(names.length),totals=new Float64Array(names.length),mins=new Float64Array(names.length).fill(Infinity),maxs=new Float64Array(names.length),histogram=new Float64Array(256);
  const tracks=[],longest=[],renamed=new Map();let scanned=0,complete=0,markers=0,counters=0,longEvents=0,sum=0,min=Infinity,max=0,batches=0,unindexedNameEvents=0,unindexedNameUs=0;
  const total=ids.reduce((n,id)=>n+trace.tracks[id].blocks.reduce((n,bi)=>{const b=trace.blocks[bi];return n+(b.start<end&&b.end>=start?b.count:0);},0),0);
  const started=performance.now();
  function abort(){if(cancelled()){const error=new Error('分析已取消');error.name='AbortError';throw error;}}
  for(const id of ids){const track=trace.tracks[id],stat={trackId:id,pid:track.pid,tid:track.tid,label:track.name,count:0,totalUs:0,maxUs:0,markers:0,counters:0};
    for(const bi of track.blocks){abort();const b=trace.blocks[bi];if(b.start>=end||b.end<start)continue;const v=trace.readBlock(b);
      for(let i=0;i<b.count;i++){
        const o=i*STEP,ts=v.getFloat64(o,true),dur=v.getFloat64(o+8,true),kind=v.getUint32(o+52,true);
        if(ts>=end||ts+dur<start||(dur>0&&ts+dur<=start))continue;
        if(kind===2){if(ts>=start){counters++;stat.counters++;}continue;}
        if(kind!==0){if(ts>=start){markers++;stat.markers++;}continue;}
        const d=Math.max(0,Math.min(end,ts+dur)-Math.max(start,ts)),name=v.getUint32(o+28,true);
        if(name>=names.length)throw Error('事件名稱索引超出範圍');
        let display;const unresolved=name===0||!trace.fullNamesVersion&&(names[name]?.length||0)>=160;
        if(!unresolved&&trace.displayName&&trace.legacyNameCandidate?.(name,track))display=trace.displayName(reference(v,o,id,names),id);
        if(unresolved){unindexedNameEvents++;unindexedNameUs+=d;}
        else if(display&&display!==names[name]){if(!renamed.has(display))renamed.set(display,{label:display,count:0,totalUs:0,minUs:Infinity,maxUs:0});const row=renamed.get(display);row.count++;row.totalUs+=d;row.minUs=Math.min(row.minUs,d);row.maxUs=Math.max(row.maxUs,d);}
        else{counts[name]++;totals[name]+=d;mins[name]=Math.min(mins[name],d);maxs[name]=Math.max(maxs[name],d);}
        complete++;sum+=d;min=Math.min(min,d);max=Math.max(max,d);stat.count++;stat.totalUs+=d;stat.maxUs=Math.max(stat.maxUs,d);
        const bin=Math.max(0,Math.min(255,Math.floor((Math.log2(Math.max(2**-20,d))+20)*4)));histogram[bin]++;
        if(d>=thresholdUs)longEvents++;
        if(longest.length<50||d>longest.at(-1).clippedUs){const record=reference(v,o,id,names);if(display)record.label=display;longest.push({record,clippedUs:d});longest.sort((a,b)=>b.clippedUs-a.clippedUs);if(longest.length>50)longest.length=50;}
      }
      scanned+=b.count;
      if(++batches%8===0){onProgress({scanned,total,complete,elapsed:(performance.now()-started)/1000});await yieldNow();abort();}
    }tracks.push(stat);
  }
  abort();for(const item of longest)if(item.record.name===0||!trace.fullNamesVersion&&(names[item.record.name]?.length||0)>=160){item.record.label=trace.displayName(item.record,item.record.trackId);await yieldNow();abort();}let cumulative=0,p95UpperUs=0;
  for(let i=0;i<histogram.length;i++){cumulative+=histogram[i];if(complete&&cumulative>=complete*.95){p95UpperUs=Math.min(max,2**((i+1)/4-20));break;}}
  const grouped=new Map(renamed);for(let id=0;id<names.length;id++)if(counts[id]){const label=names[id];if(!grouped.has(label))grouped.set(label,{label,count:0,totalUs:0,minUs:Infinity,maxUs:0});const row=grouped.get(label);row.count+=counts[id];row.totalUs+=totals[id];row.minUs=Math.min(row.minUs,mins[id]);row.maxUs=Math.max(row.maxUs,maxs[id]);}
  const byName=[...grouped.values()].map(row=>({...row,averageUs:row.totalUs/row.count}));
  byName.sort((a,b)=>b.totalUs-a.totalUs||b.count-a.count);tracks.sort((a,b)=>b.totalUs-a.totalUs||b.count-a.count);
  onProgress({scanned,total,complete,elapsed:(performance.now()-started)/1000});
  return {scope:{start,end,trackIds:ids,thresholdUs},complete,markers,counters,longEvents,totalUs:sum,minUs:complete?min:0,maxUs:max,averageUs:complete?sum/complete:0,p95UpperUs,uniqueNames:byName.length,unindexedNameEvents,unindexedNameUs,byName:byName.slice(0,100),tracks,longest,analysisSeconds:(performance.now()-started)/1000,notes:['時間範圍採 [start, end)，跨界區段會裁切。','累計時間包含巢狀及重疊區段，不是 self time、忙碌比例或核心使用率。','P95 為對數分桶的近似上界；不是精確百分位數。','名稱排行最多 100 筆、長事件最多 50 筆；原始 trace 不會截斷。',...(unindexedNameEvents?[`${unindexedNameEvents} 筆區段的名稱未完整索引（字典／容量上限或舊版摘要）；總量與軌道統計仍包含它們，名稱排行不包含。可搜尋原始名稱或重新匯入。`]:[])]};
}
