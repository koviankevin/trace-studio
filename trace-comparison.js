import {analyzeArguments} from './argument-analysis.js?v=0.6.0';
import {normalizeIdentifier} from './argument-facts.js?v=0.4.0';

// openTrace returns {trace,source,release}; the active timeline is never replaced.
export async function compareTraces(ids,value,{openTrace,scopes={},sourceNames={},cancelled=()=>false,onProgress=()=>{}}){
  const graph=value===undefined||value===null||String(value).trim()==='',tfliteId=graph?null:normalizeIdentifier(value),unique=[...new Set(ids)];
  if(!graph&&tfliteId===null||unique.length<2||unique.length>3)throw Error('請選擇 2–3 份 Trace；留空比較整張圖，或輸入有效的 TfliteID');
  const started=performance.now(),traces=[];
  for(const id of unique){let opened;try{
    if(cancelled())throw Object.assign(Error('比較已取消'),{name:'AbortError'});
    opened=await openTrace(id);let scope={};if(scopes[id]){const {start,end}=scopes[id];if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error('保存的比較時間範圍無效。');scope={start:Math.max(start,opened.trace.start),end:Math.min(end,opened.trace.end)};}
    const result=await analyzeArguments(opened.trace,{...scope,focus:graph?{kind:'tflite-all'}:{kind:'tflite',value:tfliteId},cancelled,onProgress:progress=>onProgress({...progress,id,index:traces.length+1,totalTraces:unique.length,name:opened.source.name})});
    const group=result.matchedSummary;
    traces.push({id,name:opened.source.name,status:'ok',scope:result.scope,matched:result.matched,first:group.start,spanUs:result.matched?group.end-group.start:0,totalUs:group.totalUs,cores:group.cores,pids:group.pids,contextsTruncated:group.contextsTruncated,tfliteGroups:result.groups.tflite,tfliteGroupCount:result.tfliteGroupCount,locations:result.locations,byName:result.byName,nameCount:result.nameCount,members:result.members,hasMore:result.hasMore,truncatedFacts:result.truncatedFacts,conflicts:result.conflicts,warnings:result.warnings,omittedGroupEvents:result.omittedGroupEvents,omittedNameEvents:result.omittedNameEvents,omittedLocationRanges:result.omittedLocationRanges,analysisSeconds:result.analysisSeconds});
  }catch(error){if(error.name==='AbortError')throw error;traces.push({id,name:String(sourceNames[id]||id).slice(0,400),status:'error',message:error.message});}finally{await opened?.release();}}
  if(cancelled())throw Object.assign(Error('比較已取消'),{name:'AbortError'});
  return {mode:graph?'graph':'id',tfliteId,traces,analysisSeconds:(performance.now()-started)/1000,notes:['每份 Trace 以符合條件的最早事件為相對起點；只比較所選範圍內帶 TfliteID 的事件；ID 重用可能涵蓋多次推論，請選擇可比的時間範圍。','累計時間包含跨核心、巢狀與重疊，不是實際牆鐘耗時；跨度是最早起點到最晚終點。','各列最多顯示索引順序的前 100 個符合事件，再按時間排列；表格統計掃描全部事件。','Shape、切分與實際輸出數值仍須核對來源資料；相同 ID 不代表圖結構及輸出已驗證相同。記憶體 Size 為宣告大小累計（含重用），不是流量或峰值使用量；空間最多彙整 4,096 組，核心／PID 各列前 64 個；事件名稱最多彙整 4,096 種、顯示前 100。']};
}
