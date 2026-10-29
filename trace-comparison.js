import {analyzeArguments} from './argument-analysis.js?v=0.5.0';
import {normalizeIdentifier} from './argument-facts.js?v=0.4.0';

// openTrace returns {trace,source,release}; the active timeline is never replaced.
export async function compareTraces(ids,value,{openTrace,cancelled=()=>false,onProgress=()=>{}}){
  const tfliteId=normalizeIdentifier(value),unique=[...new Set(ids)];
  if(tfliteId===null||unique.length<2||unique.length>4)throw Error('請選擇 2–4 份 Trace 並輸入有效的 TfliteID');
  const started=performance.now(),traces=[];
  for(const id of unique){let opened;try{
    if(cancelled())throw Object.assign(Error('比較已取消'),{name:'AbortError'});
    opened=await openTrace(id);const result=await analyzeArguments(opened.trace,{focus:{kind:'tflite',value:tfliteId},cancelled,onProgress:progress=>onProgress({...progress,id,index:traces.length+1,totalTraces:unique.length,name:opened.source.name})});
    const group=result.groups.tflite.find(group=>group.id===tfliteId);
    traces.push({id,name:opened.source.name,status:'ok',matched:result.matched,first:group?.start??null,spanUs:group?group.end-group.start:0,totalUs:group?.totalUs??0,cores:group?.cores||[],pids:group?.pids||[],locations:result.locations,byName:result.byName,nameCount:result.nameCount,members:result.members,hasMore:result.hasMore,truncatedFacts:result.truncatedFacts,conflicts:result.conflicts,warnings:result.warnings,omittedGroupEvents:result.omittedGroupEvents,omittedNameEvents:result.omittedNameEvents,omittedLocationRanges:result.omittedLocationRanges,analysisSeconds:result.analysisSeconds});
  }catch(error){if(error.name==='AbortError')throw error;traces.push({id,status:'error',message:error.message});}finally{await opened?.release();}}
  if(cancelled())throw Object.assign(Error('比較已取消'),{name:'AbortError'});
  return {tfliteId,traces,analysisSeconds:(performance.now()-started)/1000,notes:['每份 Trace 以該 ID 最早事件為相對起點；比較範圍為各檔案內全部同 ID 事件，ID 重用可能涵蓋多次推論。','累計時間包含跨核心、巢狀與重疊，不是實際牆鐘耗時；跨度是最早起點到最晚終點。','各列最多顯示索引順序的前 100 個符合事件，再按時間排列；表格統計掃描全部事件。','記憶體 Size 為宣告大小累計（含重用），不是流量或峰值使用量；空間最多彙整 4,096 組，事件名稱最多彙整 4,096 種、顯示前 100。']};
}
