import {PerfettoNavigation,wheelZoomRatio} from './navigation.js';
import {groupTracks,allGroups,defaultCollapsed,makeTrackLayout,revealTrack,trackName} from './track-layout.js?v=0.4.0';
import {eventSummary} from './event-summary.js?v=0.4.0';
import {eventColor,readableEventText} from './event-colors.js?v=0.10.0';
import {loadExtensionHost} from './extensions/runtime.js';
import {counterPlot,formatCounterValue} from './counter-plot.js?v=0.3.2';
import {extractArgumentFacts} from './argument-facts.js?v=0.4.0';
import {fallbackEventName,missingEventName} from './event-labels.js?v=0.4.0';
import {comparisonHTML} from './comparison-view.js?v=0.7.0';
import {selectRelationLines,groupRelationCandidates,relationRecordKey,relationKey,relationAssociations} from './relation-view.js?v=0.11.0';
import {formatTimestamp,formatTimeWindow} from './time-format.js?v=0.7.0';
import {replaceFocusedContent,trapDialogTab} from './focus.js?v=0.10.0';
import {RuntimeMetrics} from './runtime-metrics.js?v=0.8.0';
const extensionHost=await loadExtensionHost();
const $=id=>document.getElementById(id), esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={info:null,start:0,end:1,tracks:[],layout:[],rows:new Map(),groups:[],collapsed:new Set(),groupRows:new Map(),lanes:new Map(),density:'compact',pins:new Set(),expanded:new Set(),selected:null,detail:null,links:[],area:null,filter:'',view:'timeline',query:0,detailId:0,searchId:0,analysisId:0,analysis:null,analysisBusy:false,showLinks:true};
let worker,queryTimer,paintFrame,toastTimer,searchResults=[],commandIndex=0,filteredCommands=[],importing=false,queryBusy=false,queryDirty=false;
let importRecovery=null,restoringRecovery=null,importCancelling=false;
let cacheRequest=0,cacheEntries=[],cacheBusy=false,cachePage=0;
const counterEdges=new Map();
const runtimeMetrics=new RuntimeMetrics({visible:()=>document.visibilityState!=='hidden'});let displayedQuery=0;
let relationMode='manual',relationFocus=null,relationScope='',relationKeyFilter='';
function resetRelations(){relationFocus=null;relationScope='';relationKeyFilter='';}
function relationCandidates(){const groups=groupRelationCandidates(state.links,state.info?.tracks||[],state.info?.processes||{});return (relationScope?groups.find(group=>group.id===relationScope)?.links||[]:state.links).flatMap(link=>{if(!relationKeyFilter)return [link];const association=relationAssociations(link).find(item=>relationKey(item)===relationKeyFilter);return association?[{...link,...association}]:[];});}
let argumentFocus=null;
let pendingFiles=[],loadRequestId=0,workspaceRequest=0,savedTraces=[],comparisonIds=new Set(),comparisonRequest=0,comparisonBusy=false,comparisonResult=null,pendingNavigation=null;
let cacheLimit=64;try{const value=Number(localStorage.getItem('trace-studio-cache-limit')??64);if([0,32,64,128,256].includes(value))cacheLimit=value;}catch{}
const traceViews=new Map();try{for(const [id,value]of JSON.parse(localStorage.getItem('trace-studio-views')||'[]').slice(-50))traceViews.set(id,value);}catch{}
let labelWidth=250,plotWidth=700,plotHeight=420,hitboxes=[],pointer=null,overviewPointer=null,heightPointerClick=null;
const palette=['#a8c995','#aac4d9','#e3c489','#bcb2d2','#b4d7cd','#d9b7a8'];
function formatTime(us,short=false){const n=Math.abs(us);if(n>=1e6)return `${(us/1e6).toFixed(short?2:3)} s`;if(n>=1000)return `${(us/1000).toFixed(short?1:3)} ms`;return `${us.toFixed(n<1?2:1)} µs`;}
function bytes(n){return n>=1e9?`${(n/1e9).toFixed(2)} GB`:n>=1e6?`${(n/1e6).toFixed(1)} MB`:`${(n/1e3).toFixed(0)} KB`;}
function number(n){return n.toLocaleString('en-US');}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function send(type,data={}){if(['import','restore','demo','hardwareDemo'].includes(type))data={requestId:loadRequestId,...data};if(['query','detail','cancelDetail','neighbor','search','analysis'].includes(type))data={traceId:state.info?.id,...data};worker.postMessage({type,...data});}
function forgetCaches(ids){try{if(ids.includes(localStorage.getItem('trace-studio-session'))){if(state.info&&!ids.includes(state.info.id))localStorage.setItem('trace-studio-session',state.info.id);else localStorage.removeItem('trace-studio-session');}}catch{}}
function startWorker(){worker?.terminate();queryBusy=false;queryDirty=false;clearTimeout(queryTimer);queryTimer=null;const active=new Worker(new URL('./worker.js?v=0.11.0',import.meta.url),{type:'module'});worker=active;active.onmessage=event=>{if(worker===active)handleMessage(event);};active.postMessage({type:'cachePolicy',limitMB:cacheLimit});active.onerror=e=>{if(worker!==active)return;finishLoading();toast(`背景引擎錯誤：${e.message}`);};}
function finishLoading(){importing=false;importCancelling=false;if($('loading').open)$('loading').close();}
function beginLoading(title='正在讀取 Trace',remember=true){
  $('cancel-search').hidden=true;
  if(runtimeMetrics.enabled)runtimeMetrics.reset();else runtimeMetrics.cancelPending();displayedQuery=0;
  saveTraceView();loadRequestId++;state.query++;state.detailId++;state.searchId++;setComparisonBusy(false);
  queryBusy=false;queryDirty=false;clearTimeout(queryTimer);queryTimer=null;
  if(remember&&state.info)importRecovery={id:state.info.id,start:state.start,end:state.end,filter:state.filter,view:state.view,pins:new Set(state.pins),expanded:new Set(state.expanded),collapsed:new Set(state.collapsed),lanes:new Map(state.lanes),selected:state.selected,detail:state.detail,links:state.links,area:state.area,analysis:state.analysis,detailsHidden:$('details').hidden,scrollTop:$('tracks-scroll').scrollTop};
  importing=true;importCancelling=false;$('cancel').disabled=false;state.info=null;state.rows.clear();state.selected=null;state.links=[];state.area=null;state.detail=null;
  counterEdges.clear();
  argumentFocus=null;$('argument-focus').textContent='全部事件';$('argument-cross-label').hidden=true;
  state.analysis=null;state.analysisId++;setAnalysisBusy(false);$('analysis-results').innerHTML='';$('export-analysis').disabled=true;
  $('loading-title').textContent=title;$('progress-bar').style.width='0%';$('progress-bar').setAttribute('aria-valuenow','0');$('progress-percent').textContent='0%';$('progress-bytes').textContent='準備磁碟索引…';$('progress-events').textContent='0';$('progress-rate').textContent='— MB/s';
  if(!$('loading').open)$('loading').showModal();
}
function recoverImport(message){
  const previous=importRecovery||restoringRecovery;if(!previous)return false;
  restoringRecovery={...previous,notice:message};importRecovery=null;beginLoading('正在還原上一份 Trace',false);toast(`${message} 正在還原上一份 Trace。`);send('restore',{id:previous.id});return true;
}
function loadFile(file){if(!file)return;if(!/\.(json|gz|tar|tgz)$/i.test(file.name)){toast('目前支援 JSON、JSON.gz、tar、tar.gz 與 tgz。');return;}if(!worker)startWorker();beginLoading(pendingFiles.length?`正在讀取 ${file.name}（另有 ${pendingFiles.length} 份待開啟）`:'正在讀取 Trace');send('import',{file,requestId:loadRequestId});}
function loadFiles(files){if(importing){toast('請先完成或取消目前的匯入。');return;}const valid=[...files].filter(file=>/\.(json|gz|tar|tgz)$/i.test(file.name));if(!valid.length){toast('請選擇 JSON／JSON.gz／tar.gz Trace。');return;}pendingFiles=valid;loadFile(pendingFiles.shift());}
function loadDemo(){if(!worker)startWorker();beginLoading('正在準備多核心示範 Trace');send('hardwareDemo',{requestId:loadRequestId});}
function saveTraceView(){if(!state.info)return;traceViews.delete(state.info.id);traceViews.set(state.info.id,{start:state.start,end:state.end,filter:state.filter,pins:[...state.pins],expanded:[...state.expanded],collapsed:[...state.collapsed],scrollTop:$('tracks-scroll').scrollTop});while(traceViews.size>50)traceViews.delete(traceViews.keys().next().value);try{localStorage.setItem('trace-studio-views',JSON.stringify([...traceViews]));}catch{}}
function restoreTraceView(id){const view=traceViews.get(id);if(!view||typeof view!=='object')return;const start=Math.max(state.info.start,Number(view.start)),end=Math.min(state.info.end,Number(view.end));if(Number.isFinite(start)&&Number.isFinite(end)&&end>start){state.start=start;state.end=end;}state.filter=typeof view.filter==='string'?view.filter.slice(0,500):'';$('track-filter').value=state.filter;for(const key of ['pins','expanded','collapsed'])if(Array.isArray(view[key]))state[key]=new Set(view[key].slice(0,8192));}
function refreshSavedTraces(){send('sessions',{requestId:`workspace:${++workspaceRequest}`});}
function openSavedTrace(id,record=null){if(importing)return;if(id===state.info?.id){if(record)navigateRecord(record);return;}pendingNavigation=record?{id,record}:null;beginLoading('正在切換已保存的 Trace');send('restore',{id});}
function renderSavedTraces(){
  const usable=savedTraces.filter(item=>!item.busy||item.memory);if(!comparisonIds.size)comparisonIds=new Set(usable.filter(item=>!item.demo).slice(0,2).map(item=>item.id));
  replaceFocusedContent($('trace-tabs'),[...savedTraces].sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')).map(item=>`<button class="trace-tab ${item.id===state.info?.id?'active':''}" data-focus-key="trace:${item.id}" data-trace-open="${item.id}" aria-current="${item.id===state.info?.id?'page':'false'}" title="${esc(item.name)} · ${item.memory?'索引已載入':'本機已保存'}" ${item.busy&&!item.memory?'disabled':''}>${item.memory?'●':'▧'} ${esc(item.name)}</button>`).join('')||'<span>尚未保存 Trace</span>',{fallback:$('tracks-scroll')});
  $('comparison-sources').innerHTML=savedTraces.map(item=>`<label><input type="checkbox" data-comparison-id="${item.id}" ${comparisonIds.has(item.id)?'checked':''} ${item.busy&&!item.memory||comparisonBusy?'disabled':''}><span>${esc(item.name)}<small>${bytes(item.bytes)} · ${item.demo?'合成示範':item.memory?'索引已載入':item.busy?'其他分頁使用中':'本機已保存'}</small></span></label>`).join('');
}
function setComparisonBusy(busy){comparisonBusy=busy;$('run-comparison').disabled=busy;$('cancel-comparison').hidden=!busy;$('export-comparison').disabled=busy||!comparisonResult;}
function openComparison(){const id=state.detail?.facts?.ids.tflite;if(id!==undefined)$('comparison-id').value=id;setView('compare');refreshSavedTraces();}
function handleMessage({data}){
  if(data.traceId&&data.traceId!==state.info?.id)return;
  runtimeMetrics.sampleHeap();
  switch(data.type){
    case 'importCleanup':if(importCancelling)$('loading-title').textContent=data.stage==='closing'?'正在關閉未完成的索引…':'正在移除未完成的快取…';break;
    case 'progress':{
      if(importCancelling)break;
      if(data.member)$('loading-title').textContent=`正在讀取封裝：${data.member}`;
      const p=Math.min(99.9,data.bytes/Math.max(1,data.total)*100);$('progress-bar').style.width=`${p}%`;$('progress-bar').setAttribute('aria-valuenow',p.toFixed(1));$('progress-percent').textContent=`${p.toFixed(1)}%`;
      $('progress-bytes').textContent=`${bytes(data.bytes)} / ${bytes(data.total)}`;$('progress-events').textContent=number(data.events);$('progress-rate').textContent=`${(data.bytes/1e6/Math.max(.01,data.elapsed)).toFixed(1)} MB/s`;break;
    }
    case 'importCancelled':{
      if(data.requestId!==loadRequestId)break;finishLoading();if(recoverImport('已取消開檔。'))break;
      let last;try{last=localStorage.getItem('trace-studio-session');}catch{}if(last){beginLoading('正在還原上一份 Trace',false);send('restore',{id:last});}else loadDemo();break;
    }
    case 'importCancelUnavailable':if(data.requestId===loadRequestId){importCancelling=false;$('cancel').disabled=false;toast('開檔已完成或正在還原，請稍候。');}break;
    case 'ready':{
      if(data.requestId!==undefined&&data.requestId!==loadRequestId)break;
      const recovered=restoringRecovery?.id===data.info.id?restoringRecovery:null;restoringRecovery=null;importRecovery=null;
      resetRelations();state.info=data.info;state.start=data.info.start;state.end=data.info.end;state.selected=null;state.detail=null;state.links=[];state.pins.clear();state.expanded.clear();state.lanes.clear();state.rows.clear();state.groupRows.clear();state.groups=groupTracks(data.info.tracks,data.info.processes);state.collapsed=defaultCollapsed(state.groups);state.filter='';$('track-filter').value='';setDetailsVisible(false);$('selection-status').textContent='';finishLoading();
      try{localStorage.setItem('trace-studio-session',data.info.id);}catch{}
      if(recovered){for(const key of ['start','end','filter','view','pins','expanded','collapsed','lanes','selected','detail','links','area','analysis'])state[key]=recovered[key];$('track-filter').value=state.filter;setDetailsVisible(!recovered.detailsHidden);}
      else restoreTraceView(data.info.id);
      updateInfo(data.restored);setView(recovered?.view||'timeline');updateLayout();if(recovered){$('tracks-scroll').scrollTop=recovered.scrollTop;renderLabels();if(state.detail)renderDetail();if(state.analysis)renderAnalysis();else $('analysis-status').textContent='可重新選擇範圍並開始分析。';}drawOverview();requestQuery();
      if(!recovered&&!data.info.source.demo)toast(data.memoryRestored?'已直接切換至小檔索引快取。':data.restored?'已從本機快取還原，不需重新解析。':`已完成索引：${number(data.info.count)} 筆事件，${data.info.importSeconds.toFixed(2)} 秒。`);
      if(data.archive)toast(`封裝已保存 ${data.archive.imported} 份 Trace；${data.archive.skipped} 份略過、${data.archive.failed} 份失敗。${data.archive.complete?'':` 封裝未完整讀完：${data.archive.error}`}`);
      if(recovered){toast(`${recovered.notice} 已返回上一份 Trace。`);if(state.view==='events'&&$('search-input').value.trim())search();}else{searchResults=[];$('search-input').value='';$('search-results').innerHTML='<p class="empty-state">輸入關鍵字搜尋目前的 Trace。每次最多顯示 100 筆。</p>';}
      refreshSavedTraces();if(!recovered){const scroll=traceViews.get(data.info.id)?.scrollTop;if(Number.isFinite(scroll))$('tracks-scroll').scrollTop=Math.max(0,Math.min(1e8,scroll));renderLabels();requestQuery();}if(pendingNavigation?.id===data.info.id){const record=pendingNavigation.record;pendingNavigation=null;navigateRecord(record);}if(pendingFiles.length)loadFile(pendingFiles.shift());
      break;
    }
    case 'query':{
      queryBusy=false;if(data.requestId===state.query){runtimeMetrics.received(data.requestId,data.ms);displayedQuery=data.requestId;state.rows=new Map(data.rows.map(r=>[r.id,r.rows]));state.groupRows=new Map((data.groups||[]).map(r=>[r.id,r.bins]));
        counterEdges.clear();for(const row of data.rows)counterEdges.set(row.id,{before:row.before,after:row.after});
        let changed=false;for(const item of data.rows){const lanes=Math.min(4,item.rows.reduce((max,r)=>Math.max(max,1+(r.lane||0)),1));if(lanes>(state.lanes.get(item.id)||1)){state.lanes.set(item.id,lanes);changed=true;}}
        $('render-info').textContent=`${data.ms.toFixed(1)} ms · ${number(data.rows.reduce((n,r)=>n+r.rows.length,0))} 節點`;
        if(changed&&state.density==='compact')updateLayout();paint();
      }if(queryDirty){queryDirty=false;requestQuery();}break;
    }
    case 'detail':if(data.requestId===state.detailId){state.detail=data;state.links=data.links?.matches||[];renderDetail();paint();}break;
    case 'searchProgress':if(data.requestId===state.searchId)$('search-results').innerHTML=`<p class="empty-state">搜尋中… 已掃描 ${number(data.scanned)} 筆索引</p>`;break;
    case 'search':if(data.requestId===state.searchId){$('cancel-search').hidden=true;searchResults=data.results;renderEventRows($('search-results'),data.results,data.capped?'顯示前 100 筆符合結果。縮小關鍵字可找到更精確的事件。':`找到 ${number(data.results.length)} 筆事件。`,true);}break;
    case 'searchCancelled':if(data.requestId===state.searchId){$('cancel-search').hidden=true;searchResults=[];$('search-results').innerHTML='<p class="empty-state">搜尋已取消，Trace 保留。</p>';}break;
    case 'neighbor':if(data.record)selectRecord(data.record,true);else toast('已到達這條軌道的邊界。');break;
    case 'analysisProgress':if(data.requestId===state.analysisId)$('analysis-status').textContent=data.stage==='args'?`解析 Args：${number(data.scanned)} / ${number(data.total)} 筆索引，已讀 ${number(data.events)} 個事件${data.focused?`，符合 ${number(data.matched)} 筆`:``}，${data.elapsed.toFixed(1)} 秒。時間軸仍可操作。`:`背景分析中：${number(data.scanned)} / ${number(data.total)} 筆索引，已找到 ${number(data.complete)} 個區段，${data.elapsed.toFixed(1)} 秒。時間軸仍可操作。`;break;
    case 'analysis':if(data.requestId===state.analysisId){state.analysis=data.result;setAnalysisBusy(false);renderAnalysis();}break;
    case 'analysisCancelled':if(data.requestId===state.analysisId){setAnalysisBusy(false);$('analysis-status').textContent='分析已取消，trace 保留。';}break;
    case 'cachePolicy':refreshSavedTraces();break;
    case 'sessions':if(data.requestId===`workspace:${workspaceRequest}`){savedTraces=data.sessions.filter(item=>item.complete);renderSavedTraces();}else if(data.requestId===cacheRequest){cacheBusy=false;cacheEntries=data.sessions;renderCaches();$('cache-status').textContent=`${cacheEntries.length} 份快取，共 ${bytes(cacheEntries.reduce((n,s)=>n+s.bytes,0))}。`; }break;
    case 'comparisonProgress':if(data.requestId===comparisonRequest)$('comparison-status').textContent=`${data.index}/${data.totalTraces} · ${data.name} · 已讀 ${number(data.events)} 筆，符合 ${number(data.matched)} 筆。時間軸仍可操作。`;break;
    case 'comparison':if(data.requestId===comparisonRequest){comparisonResult=data.result;setComparisonBusy(false);$('comparison-results').innerHTML=comparisonHTML(data.result,{esc,time:formatTime,bytes:memoryBytes,number});$('comparison-status').textContent=`比較完成 · ${data.result.analysisSeconds.toFixed(2)} 秒；點選時間列可開啟該事件。`;$('export-comparison').disabled=false;}break;
    case 'comparisonCancelled':if(data.requestId===comparisonRequest){setComparisonBusy(false);$('comparison-status').textContent='比較已取消，保存的 Trace 保留。';}break;
    case 'sessionRemoved':refreshSavedTraces();if(data.requestId===cacheRequest){if(data.removed)forgetCaches([data.id]);cacheBusy=false;cacheEntries=data.sessions;renderCaches();$('cache-status').textContent=data.removed?'已清除這份快取。':data.reason==='busy'?'這份快取正在其他分頁使用，已保留。':data.reason==='unsupported'?'此瀏覽器無法安全清理未完成快取，請改用桌面 Chrome／Edge。':`無法清除：${data.message||'請稍後重試'}`;}break;
    case 'unusedCleared':refreshSavedTraces();if(data.requestId===cacheRequest){forgetCaches(data.removed);cacheBusy=false;cacheEntries=data.sessions;renderCaches();$('cache-status').textContent=`已清除 ${data.removed.length} 份；保留目前及使用中／無法清理的 ${data.skipped.length} 份。`;}break;
    case 'cleared':try{if(data.removed?.includes(localStorage.getItem('trace-studio-session')))localStorage.removeItem('trace-studio-session');}catch{}state.info=null;importRecovery=null;restoringRecovery=null;cacheBusy=false;$('cache-dialog').close();toast(`已清除 ${data.removed?.length||0} 份快取，保留 ${data.skipped?.length||0} 份使用中／無法清理的快取。`);loadDemo();break;
    case 'error':{
      const expected={query:state.query,search:state.searchId,detail:state.detailId,analysis:state.analysisId,compare:comparisonRequest}[data.operation];if(expected!==undefined&&data.requestId!==expected)break;
      if(['import','restore','hardwareDemo','demo'].includes(data.operation)&&data.requestId!==undefined&&data.requestId!==loadRequestId)break;
      if(['import','restore','hardwareDemo','demo'].includes(data.operation)){pendingFiles=[];pendingNavigation=null;}
      if(data.operation==='compare'&&data.requestId===comparisonRequest){setComparisonBusy(false);$('comparison-status').textContent=data.message;}
      if(['import','restore','hardwareDemo','demo'].includes(data.operation))finishLoading();toast(data.message);
      if(data.operation==='query'){queryBusy=false;queryDirty=false;}
      if(data.operation==='search'){$('cancel-search').hidden=true;$('search-results').innerHTML=`<p class="empty-state">${esc(data.message)}</p>`;}
      if(['sessions','removeSession','clearUnused','clear'].includes(data.operation)){cacheBusy=false;renderCaches();$('cache-status').textContent=data.message;}
      if(data.operation==='analysis'&&data.requestId===state.analysisId){setAnalysisBusy(false);$('analysis-status').textContent=data.message;}
      if(data.operation==='restore'){if(restoringRecovery){restoringRecovery=null;importRecovery=null;$('file-name').textContent='無法還原上一份 Trace';$('file-subtitle').textContent='可重新選擇原始檔案';}else if(!recoverImport(data.message)){try{if(!['SessionBusyError','NoModificationAllowedError'].includes(data.code))localStorage.removeItem('trace-studio-session');}catch{}loadDemo();}}
      else if(data.operation==='import'||data.operation==='demo'||data.operation==='hardwareDemo'){if(recoverImport(data.message))break;state.info=null;state.rows.clear();$('file-name').textContent='無法開啟 Trace';$('file-subtitle').textContent='請選擇另一個 JSON 檔案';$('details-content').innerHTML=`<div class="selection-empty">${esc(data.message)}</div>`;paint();}
      break;
    }
  }
}
function updateInfo(restored=false){
  const i=state.info,processes=new Set(i.tracks.map(t=>String(t.pid))),tracks=i.tracks.filter(t=>t.count>0);
  $('side-file').textContent=i.source.name;$('side-size').textContent=`${bytes(i.source.size)}${i.source.demo?' · 示範資料':''}`;
  $('file-name').textContent=i.source.name;$('file-subtitle').textContent=`${bytes(i.source.size)} · ${i.source.demo?'合成示範資料':'Chrome Trace JSON'} · 僅本機`;
  const duration=i.end-i.start,unit=duration>=1e6?'s':duration>=1000?'ms':'µs',value=duration/(unit==='s'?1e6:unit==='ms'?1000:1);
  $('duration').innerHTML=`${value.toFixed(2)} <em>${unit}</em>`;$('events-count').textContent=number(i.count);
  $('process-count').innerHTML=`${processes.size} <em>/</em> ${tracks.length}`;$('track-count').textContent=tracks.length;
  $('threads-sub').textContent=`${Object.keys(i.phases).length} 種事件類型 · ${number(i.slices)} 筆可視化事件`;
  $('import-time').innerHTML=`${i.importSeconds.toFixed(2)} <em>s</em>`;$('cache-sub').textContent=restored?'已從本機磁碟快取還原':'Worker 解析＋磁碟建索引';
  $('overview-end').textContent=formatTime(i.end-i.start,true);
  $('analysis-group').innerHTML='<option value="all">全部</option>'+allGroups(state.groups).map(group=>`<option value="${esc(group.id)}">${esc(group.label)}${group.id.startsWith('counter-')?' · 數值曲線':''}</option>`).join('');setAnalysisBusy(false);
  renderEventRows($('insights-list'),i.top,'事件持續時間，非獨占 CPU 耗時。',false);
  const phases=Object.entries(i.phases).map(([ph,n])=>`<div class="info-line"><span>ph = ${esc(ph)}</span><span>${number(n)}</span></div>`).join('');
  $('info-content').innerHTML=`<div class="info-panel"><h3>來源與儲存</h3>${infoLine('檔案',i.source.name)}${infoLine('原始大小',bytes(i.source.size))}${infoLine('索引＋事件快取',bytes(i.diskBytes+(i.relations?.bytes||0)))}${infoLine('關聯索引',number(i.relations?.count||0))}${infoLine('完整事件數',number(i.count))}${infoLine('瀏覽器',navigator.userAgent||'未提供')}<p>原始事件在本機磁碟保留。畫面會依解析度聚合密集事件；放大可繼續展開，點選可讀取原始 JSON。未經過網路上傳。</p></div><div class="info-panel"><h3>事件類型</h3>${phases}</div><div class="info-panel"><h3>解析品質</h3>${infoLine('無法繪製／metadata 過大',number(i.skipped))}${infoLine('未配對 B / E',number(i.unmatched))}${infoLine('逆序時間戳',number(i.outOfOrder))}${infoLine('名稱按需讀取',number(i.nameLimit))}<p class="${i.unmatched||i.skipped||i.outOfOrder?'warning':''}">X 完整事件、B/E 同步區段、I/i/R 即時事件、C counter 可視化。其他 phase 保留為標記。非同步事件尚未重建區段。逆序資料仍可查詢，但可能增加磁碟讀取。</p></div><div class="info-panel"><h3>位址與關聯</h3><p>自動辨識 args 中的 address / addr / ptr / pointer 與十六進位字串，按精確位址連結。另支援明確 defines / uses 及 s/t/f flow ID。相同位址不代表因果關係、相同配置生命週期或範圍重疊；大於安全整數的數值 address 請用字串記錄。</p><p>每事件最多 32 個關聯鍵，每次顯示最多 64 筆關聯。完整原始 args 仍可讀取。</p></div><div class="info-panel full"><h3>檔案 Metadata</h3><div class="json-tree">${tree(i.metadata)}</div></div><div class="info-panel full"><h3>大檔設計與目前邊界</h3><p>分段讀取 → Worker 解析 → OPFS 磁碟索引 → 可見軌道查詢 → Canvas 繪製。未將整份 JSON 或全部事件載入主執行緒。需要桌面 Chrome / Edge、HTTPS 與足夠的瀏覽器儲存額度。3 GB 檔案的實際載入時間取決於事件數、args 大小、硬碟、可用空間與瀏覽器；請參考 GitHub 中公開的測試結果。目前支援最多三份 Trace 的 TfliteID／圖版本統計比較；尚未支援 Perfetto protobuf、SQL 與 stack sampling 重建。</p></div>`;
}
function infoLine(a,b){return `<div class="info-line"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;}
function runtimeReport(){return {...runtimeMetrics.snapshot(),trace:state.info?{events:state.info.count,tracks:state.info.tracks.length,inputBytes:state.info.source.size,cacheBytes:state.info.diskBytes}:null,viewport:{width:innerWidth,height:innerHeight,pixelRatio:devicePixelRatio},visibility:document.visibilityState,browser:navigator.userAgent||null};}
function renderRuntimeMetrics(){const report=runtimeReport(),ms=value=>value===null?'尚無樣本':`${value.toFixed(1)} ms`;
  $('runtime-json').value=JSON.stringify(report,null,2);
  $('runtime-toggle').textContent=report.enabled?'停止記錄':'開始記錄';$('runtime-toggle').setAttribute('aria-pressed',String(report.enabled));$('runtime-count').textContent=number(report.completedFrames);
  $('runtime-status').textContent=report.enabled?'記錄中：切回時間軸縮放或平移，再回來查看。':report.completedFrames?'已停止記錄，保留本次結果；可複製或展開 JSON 查看。':'手動開啟後只記錄本機耗時與數量；切換 Trace 會重新計數。';
  $('runtime-results').innerHTML=infoLine('Canvas 更新 P50 / P95',`${ms(report.canvas.medianMs)} / ${ms(report.canvas.p95Ms)}`)+infoLine('Worker 查詢 P50 / P95',`${ms(report.worker.medianMs)} / ${ms(report.worker.p95Ms)}`)+infoLine('查詢往返 P50 / P95',`${ms(report.roundTrip.medianMs)} / ${ms(report.roundTrip.p95Ms)}`)+infoLine('主頁長任務 ≥50 ms',report.longTasks.supported?`${report.longTasks.count} 次 · 最長 ${ms(report.longTasks.maxMs)}`:'瀏覽器未提供')+infoLine('JS heap 抽樣最大值',report.heap.maxSampledBytes===null?'瀏覽器未提供':bytes(report.heap.maxSampledBytes))+infoLine('採樣視窗 / 合併更新 / 背景略過',`${report.canvas.samples} / ${report.coalescedIntents} / ${report.hiddenOmitted}`);
}
function tree(obj,depth=0){
  if(obj===null||typeof obj!=='object')return `<span class="json-value">${esc(typeof obj==='string'?obj:JSON.stringify(obj))}</span>`;
  if(depth>12)return `<span class="json-value">結構深度超過 12 層，請展開下方原始 JSON。</span>`;
  const entries=Object.entries(obj);return entries.slice(0,200).map(([key,value])=>{
    if(value!==null&&typeof value==='object')return `<details open><summary><span class="json-key">${esc(key)}</span> <span class="json-value">${Array.isArray(value)?`Array(${value.length})`:`{ ${Object.keys(value).length} }`}</span></summary>${tree(value,depth+1)}</details>`;
    const address=/address|addr|ptr|pointer/i.test(key)||typeof value==='string'&&/^0x[0-9a-f]+$/i.test(value);
    const text=typeof value==='string'?value:JSON.stringify(value);return `<div class="json-leaf"><span class="json-key">${esc(key)}</span><span class="json-value ${address?'address':''}">${esc(text?.length>16000?text.slice(0,16000)+'…（完整內容見原始 JSON）':text)}</span></div>`;
  }).join('')+(entries.length>200?'<p>前 200 個欄位；完整資料請查看原始 JSON。</p>':'');
}
function setView(view){const leaving=document.activeElement?.closest?.('.view')?.id;state.view=view;document.body.classList.toggle('timeline-workspace',view==='timeline');document.querySelectorAll('.view').forEach(e=>e.classList.toggle('active',e.id===`${view}-view`));document.querySelectorAll('.nav').forEach(e=>{e.classList.toggle('active',e.dataset.view===view);if(e.dataset.view===view)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current');});$('breadcrumb').textContent=({timeline:'時間軸',events:'事件搜尋',insights:'Trace 分析',info:'Trace 資訊',compare:'Trace 比較'})[view];if(view==='timeline'){measure();requestQuery();}if(view==='events')$('search-input').focus();else if(leaving&&leaving!==`${view}-view`){if(view==='timeline')focusTimeline();else $(`${view}-view`).focus({preventScroll:true});}if(view==='info')renderRuntimeMetrics();}
function updateLayout(){
  const scroll=$('tracks-scroll'),oldTop=scroll.scrollTop,anchor=state.layout.find(r=>r.y+r.h>oldTop),offset=anchor?oldTop-anchor.y:0;
  const result=makeTrackLayout(state.groups,{collapsed:state.collapsed,filter:state.filter,pins:state.pins,expanded:state.expanded,density:state.density,lanes:state.lanes});state.layout=result.rows;
  const included=new Set(result.rows.flatMap(r=>r.type==='group'?r.trackIds:[r.track.id]));state.tracks=(state.info?.tracks||[]).filter(t=>included.has(t.id));
  $('tracks-space').style.height=`${Math.max(64,result.height)}px`;$('track-labels').style.height=`${result.height}px`;
  const next=anchor&&state.layout.find(r=>r.id===anchor.id);if(next)scroll.scrollTop=next.y+offset;
  $('track-visible').textContent=`${state.layout.filter(r=>r.type==='track').length} / ${state.tracks.length} 軌道`;
  measure();renderLabels();requestQuery();
}
function measure(){if(state.view!=='timeline')return;labelWidth=parseInt(getComputedStyle(document.documentElement).getPropertyValue('--label-width'))||250;const rect=$('tracks-scroll').getBoundingClientRect();plotWidth=Math.max(80,rect.width-labelWidth);plotHeight=rect.height;describeDrawer();paint();drawOverview();}
function visibleLayout(){const top=$('tracks-scroll').scrollTop;return state.layout.filter(r=>r.y+r.h>=top&&r.y<=top+plotHeight);}
function renderLabels(){
  replaceFocusedContent($('track-labels'),visibleLayout().map(row=>{
    if(row.type==='group')return `<div class="track-label group-label ${row.group.kind}" style="top:${row.y}px;height:${row.h}px;padding-left:${8+row.depth*12}px"><button class="group-toggle" data-focus-key="group:${esc(row.group.id)}" data-group="${esc(row.group.id)}" aria-expanded="${!row.collapsed}" title="${esc(row.group.label)}${row.group.pid===null?'':` · PID ${esc(row.group.pid)}`} · ${row.trackIds.length} 條軌道"><span>${row.collapsed?'▸':'▾'}</span><b>${esc(row.group.label)}</b><small>${row.trackIds.length}</small></button></div>`;
    const {track:t,y,h}=row;return `<div class="track-label" style="top:${y}px;height:${h}px;padding-left:${8+row.depth*12}px" data-track="${t.id}" title="${esc(t.name)} · PID ${esc(t.pid)} · TID ${esc(t.tid)} · ${number(t.count)} events；雙擊展開高度"><div class="track-label-top"><i class="track-color" style="background:${palette[t.id%palette.length]}"></i><button class="track-title track-height" data-focus-key="height:${t.id}" data-track-toggle="${t.id}" aria-label="調整軌道 ${esc(t.name)} 的高度" aria-expanded="${state.expanded.has(t.id)}" title="點選或雙擊切換軌道高度">${esc(row.displayName)}</button><button class="pin ${state.pins.has(t.id)?'pinned':''}" data-focus-key="pin:${t.id}" data-pin="${t.id}" aria-pressed="${state.pins.has(t.id)}" title="${state.pins.has(t.id)?'取消釘選':'釘選軌道'}" aria-label="${state.pins.has(t.id)?'取消釘選':'釘選'} ${esc(t.name)}">⌖</button></div><div class="track-meta"><span style="line-height:2">${number(t.count)} ${t.kind==='counter'?'samples':'events'}</span></div></div>`;
  }).join(''),{fallback:$('tracks-scroll')});
}
function requestQuery(){paint();if(!state.info||state.view!=='timeline'||importing)return;if(queryBusy){queryDirty=true;return;}if(queryTimer)return;queryTimer=setTimeout(()=>{queryTimer=null;if(!state.info||importing)return;state.query++;queryBusy=true;runtimeMetrics.sent(state.query);const visible=visibleLayout();send('query',{requestId:state.query,start:state.start,end:state.end,trackIds:visible.filter(r=>r.type==='track').map(r=>r.track.id),groups:visible.filter(r=>r.type==='group'&&r.collapsed).map(r=>({id:r.id,trackIds:r.trackIds})),width:Math.ceil(plotWidth)});},25);}
function setRange(start,end){if(!state.info)return;const total=state.info.end-state.info.start,span=Math.max(.1,Math.min(total,end-start));if(start<state.info.start)start=state.info.start;if(start+span>state.info.end)start=state.info.end-span;if(start!==state.start||start+span!==state.end)runtimeMetrics.intent();state.start=start;state.end=start+span;requestQuery();drawOverview();}
function zoom(factor,anchor=.5){const span=state.end-state.start,newSpan=span*factor,center=state.start+span*anchor;setRange(center-newSpan*anchor,center+newSpan*(1-anchor));}
function pan(fraction){const delta=(state.end-state.start)*fraction;setRange(state.start+delta,state.end+delta);}
function fitAll(){if(state.info)setRange(state.info.start,state.info.end);}
function focusSelection(){if(state.area){const d=Math.max(.1,state.area.end-state.area.start);setRange(state.area.start-d*.1,state.area.end+d*.1);}else if(state.selected){const r=state.selected,d=Math.max(10,r.dur||100);setRange(r.ts-d*.2,r.ts+d*1.2);scrollToTrack(r.trackId);}else fitAll();}
function scrollToTrack(id){revealTrack(state.groups,state.collapsed,id);updateLayout();const row=state.layout.find(r=>r.track?.id===id);if(row){const scroll=$('tracks-scroll');if(row.y<scroll.scrollTop||row.y+row.h>scroll.scrollTop+plotHeight)scroll.scrollTop=Math.max(0,row.y-40);renderLabels();requestQuery();}}
function canvasSetup(canvas,width,height){const dpr=devicePixelRatio||1;if(canvas.width!==Math.floor(width*dpr)||canvas.height!==Math.floor(height*dpr)){canvas.width=Math.floor(width*dpr);canvas.height=Math.floor(height*dpr);}canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);return ctx;}
function tickStep(){const raw=(state.end-state.start)/Math.max(1,Math.floor(plotWidth/110)),mag=10**Math.floor(Math.log10(raw));return [1,2,5,10].find(x=>x*mag>=raw)*mag;}
function xTime(t){return (t-state.start)/(state.end-state.start)*plotWidth;}
function timeX(x){return state.start+x/plotWidth*(state.end-state.start);}
function paint(){if(paintFrame)return;paintFrame=requestAnimationFrame(()=>{paintFrame=0;drawTimeline();});}
function drawTimeline(){
  if(state.view!=='timeline')return;const canvas=$('timeline'),scroll=$('tracks-scroll').scrollTop;canvas.style.top=`${scroll}px`;
  const rulerHeight=$('ruler').parentElement.clientHeight||30;
  const ctx=canvasSetup(canvas,plotWidth,plotHeight),ruler=canvasSetup($('ruler'),plotWidth,rulerHeight),dark=document.body.classList.contains('dark');hitboxes=[];
  ctx.fillStyle=dark?'#1c2b22':'#fcfdfb';ctx.fillRect(0,0,plotWidth,plotHeight);
  if(!state.info)return;const step=tickStep(),origin=state.info.start,candidates=state.showLinks?relationCandidates():[],highlighted=new Set(candidates.filter(link=>relationAssociations(link).some(item=>item.relation.type==='address')).map(link=>relationRecordKey(link.record)));
  for(let t=Math.ceil((state.start-origin)/step)*step+origin;t<=state.end;t+=step){const x=Math.round(xTime(t))+.5;ctx.strokeStyle=dark?'#2e3d31':'#ebeee7';ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,plotHeight);ctx.stroke();ruler.fillStyle=dark?'#b8c8ac':'#586a50';ruler.font='12px Consolas,monospace';ruler.fillText(formatTimestamp(t-origin,step),x+5,Math.round(rulerHeight*.7));}
  for(const row of visibleLayout()){
    const y=row.y-scroll;ctx.strokeStyle=dark?'#344239':'#e7ece3';ctx.beginPath();ctx.moveTo(0,y+row.h-.5);ctx.lineTo(plotWidth,y+row.h-.5);ctx.stroke();
    if(row.type==='group'){
      ctx.fillStyle=dark?'#34423966':'#e7ede480';ctx.fillRect(0,y,plotWidth,row.h-1);
      if(row.collapsed){const bins=state.groupRows.get(row.id)||[],max=Math.max(1,...bins),width=plotWidth/Math.max(1,bins.length);
        for(let i=0;i<bins.length;i++)if(bins[i]){ctx.fillStyle=dark?`rgba(155,191,135,${.25+.65*Math.sqrt(bins[i]/max)})`:`rgba(99,143,78,${.18+.62*Math.sqrt(bins[i]/max)})`;ctx.fillRect(i*width,y+8,Math.max(1,width),row.h-16);}
        const related=candidates.filter(link=>row.trackIds.includes(link.record.trackId));if(related.length){ctx.fillStyle=dark?'#ead291':'#82651c';ctx.font='12px Consolas,monospace';ctx.fillText(`⌁ ${new Set(related.map(link=>relationRecordKey(link.record))).size} 候選`,8,y+row.h-6);}
        hitboxes.push({x:0,y,w:plotWidth,h:row.h,groupId:row.id,label:row.group.label,count:row.trackIds.length});
      }continue;
    }
    const rows=state.rows.get(row.track.id)||[];
    if(row.track.kind==='counter'){
      const plot=counterPlot({rows,...counterEdges.get(row.track.id),start:state.start,end:state.end});
      if(plot.points.length){
        const xy=point=>({x:point.x*plotWidth,y:y+row.h-8-point.y*(row.h-16)});
        ctx.beginPath();plot.points.forEach((point,i)=>{const p=xy(point);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);if(point.record)hitboxes.push({x:p.x-4,y:p.y-7,w:8,h:14,record:point.record});});
        ctx.strokeStyle=eventColor({label:row.track.name},true).fill;ctx.lineWidth=1.3;ctx.stroke();ctx.lineWidth=1;
        ctx.lineTo(plot.points.at(-1).x*plotWidth,y+row.h-8);ctx.lineTo(plot.points[0].x*plotWidth,y+row.h-8);ctx.closePath();ctx.fillStyle=eventColor({label:row.track.name},dark).fill+'28';ctx.fill();
        for(const point of plot.points)if(point.record){const selected=state.selected?.offset===point.record.offset&&state.selected.trackId===row.track.id;if(highlighted.has(relationRecordKey(point.record))){const p=xy(point);ctx.beginPath();ctx.arc(p.x,p.y,6,0,Math.PI*2);ctx.strokeStyle=dark?'#ead291':'#9b751b';ctx.stroke();}if(selected||plot.points.length<64){const p=xy(point);ctx.beginPath();ctx.arc(p.x,p.y,selected?4:2,0,Math.PI*2);ctx.fillStyle=selected?(dark?'#eef3df':'#244d35'):eventColor({label:row.track.name},true).fill;ctx.fill();}}
        ctx.fillStyle=dark?'#b8c9ab':'#586a50';ctx.font='12px Consolas,monospace';ctx.fillText(formatCounterValue(plot.max),8,y+13);if(plot.min!==plot.max)ctx.fillText(formatCounterValue(plot.min),8,y+row.h-2);
      }
      continue;
    }
    const maxLane=state.expanded.has(row.track.id)?8:4,laneHeight=state.density==='compact'?17:state.expanded.has(row.track.id)?22:19;
    for(const r of rows){const lane=Math.min(maxLane-1,r.lane||0),x=Math.max(-2,xTime(r.ts)),right=Math.min(plotWidth+2,xTime(r.ts+Math.max(0,r.dur))),w=Math.max(2,right-x-.8),py=y+(state.density==='compact'?7:9)+lane*(laneHeight+1);if(x>plotWidth||right<0)continue;
      const selected=state.selected?.offset===r.offset;
      const visual=extensionHost.eventColor(r,{dark})||eventColor(r,dark);ctx.fillStyle=visual.fill;
      if(r.kind===1||r.kind===3){ctx.beginPath();ctx.moveTo(x,py+1);ctx.lineTo(x+4,py+laneHeight/2);ctx.lineTo(x,py+laneHeight-1);ctx.lineTo(x-4,py+laneHeight/2);ctx.closePath();ctx.fill();}
      else {ctx.beginPath();ctx.roundRect(x,py,w,laneHeight-1,1.5);ctx.fill();}
      if(!selected&&!(r.n>1)&&highlighted.has(relationRecordKey(r))){ctx.save();ctx.setLineDash([3,2]);ctx.strokeStyle=dark?'#ead291':'#9b751b';ctx.strokeRect(x-.5,py-.5,Math.max(3,w+1),laneHeight);ctx.restore();}
      if(selected){ctx.strokeStyle=dark?'#e4efb6':'#476f39';ctx.lineWidth=1.8;ctx.strokeRect(x-.5,py-.5,Math.max(3,w+1),laneHeight);ctx.lineWidth=1;}
      if(w>58&&r.kind===0){ctx.save();ctx.beginPath();ctx.rect(x+3,py,w-6,laneHeight);ctx.clip();ctx.font=`${state.expanded.has(row.track.id)?13:12}px Consolas,monospace`;ctx.fillStyle=readableEventText(visual.fill);ctx.fillText(r.label+(r.n>1?` ×${r.n}`:''),x+4,py+laneHeight-5);ctx.restore();}
      hitboxes.push({x,y:py,w:Math.max(5,w),h:laneHeight,record:r});
    }
  }
  if(state.showLinks&&state.selected&&state.links.length){
    const points=new Map(hitboxes.filter(box=>box.record&&!(box.record.n>1)).map(box=>[relationRecordKey(box.record),{x:xTime(box.record.ts),y:box.y+box.h/2}])),source=points.get(relationRecordKey(state.selected));
    if(source){ctx.save();ctx.strokeStyle=dark?'#ead291':'#b49b58';ctx.lineWidth=1.3;
      for(const link of selectRelationLines(candidates,state.selected,state.info.tracks,{mode:relationMode,start:state.start,end:state.end,width:plotWidth,focus:relationFocus})){
        let target=points.get(relationRecordKey(link.record));if(!target){const group=state.layout.find(row=>row.type==='group'&&row.collapsed&&row.trackIds.includes(link.record.trackId));if(group)target={x:xTime(link.record.ts),y:group.y-scroll+group.h/2};}if(!target)continue;
        const sx=source.x,sy=source.y,x=target.x,y=target.y;if(Math.max(sx,x)<0||Math.min(sx,x)>plotWidth)continue;
        ctx.setLineDash(link.relation.type==='address'?[4,3]:[]);ctx.beginPath();ctx.moveTo(sx,sy);ctx.bezierCurveTo(sx+(x-sx)/2,sy,sx+(x-sx)/2,y,x,y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=dark?'#ead291':'#b49b58';ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();
      }ctx.restore();
    }
  }
  if(state.area){const x1=xTime(state.area.start),x2=xTime(state.area.end);ctx.fillStyle='#8fb58c26';ctx.fillRect(x1,0,x2-x1,plotHeight);ctx.strokeStyle='#799d64';ctx.setLineDash([3,3]);for(const x of [x1,x2]){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,plotHeight);ctx.stroke();}ctx.setLineDash([]);}
  $('window-time').textContent=formatTimeWindow(state.start,state.end,origin);if(runtimeMetrics.frame(displayedQuery))$('runtime-count').textContent=number(runtimeMetrics.frameCount);
}
function drawOverview(){if(!state.info||state.view!=='timeline')return;const wrap=$('overview-wrap'),w=wrap.clientWidth,h=wrap.clientHeight;if(!w||!h)return;const ctx=canvasSetup($('overview'),w,h),bins=state.info.overview,max=Math.max(...bins,1),dark=document.body.classList.contains('dark');const bw=w/bins.length;
  bins.forEach((n,i)=>{const height=2+Math.pow(n/max,.55)*(h-4);ctx.fillStyle=dark?'#78976b':'#c0d0ad';ctx.fillRect(i*bw,h-height,Math.max(1,bw-1),height);ctx.fillStyle=dark?'#aec29a':'#95af7e';ctx.fillRect(i*bw,h-height,Math.max(1,bw-1),1);});const total=state.info.end-state.info.start;$('overview-window').style.left=`${(state.start-state.info.start)/total*100}%`;$('overview-window').style.width=`${(state.end-state.start)/total*100}%`;}
function focusTimeline(){if(state.view==='timeline')$('tracks-scroll').focus({preventScroll:true});}
function setDetailsVisible(visible){const hadFocus=$('details').contains?.(document.activeElement);$('details').hidden=!visible;$('toggle-details').setAttribute('aria-expanded',String(visible));if(!visible&&hadFocus)focusTimeline();}
function toggleDetails(){setDetailsVisible($('details').hidden);}
function selectRecord(r,ensureVisible=false){if(!state.info)return;if($('details').contains?.(document.activeElement))focusTimeline();resetRelations();state.selected=r;state.area=null;state.detail=null;state.links=[];state.detailId++;$('selection-heading').textContent=r.label||'事件詳情';$('details-content').innerHTML='<div class="selection-empty">讀取原始事件與位址關聯…</div>';setDetailsVisible(true);$('selection-status').textContent=`已選取 ${String(r.label||'事件').slice(0,160)}，${r.kind===2?'數值 '+formatCounterValue(r.value):'持續 '+formatTime(r.dur||0)}，${trackName(state.info.tracks[r.trackId])}。`;send('detail',{requestId:state.detailId,record:r});if(ensureVisible){const d=Math.max(100,r.dur);if(r.ts<state.start||r.ts+r.dur>state.end)setRange(r.ts-d*.3,r.ts+d*1.4);scrollToTrack(r.trackId);}paint();}
function clearSelection(){state.detailId++;send('cancelDetail');$('selection-status').textContent='已清除事件選取。';resetRelations();state.selected=null;state.detail=null;state.links=[];state.area=null;$('selection-heading').textContent='目前選取';$('selection-badge').textContent='EVENT DETAILS';$('details-content').innerHTML='<div class="selection-empty">↖ 點選事件查看 args、位址關聯與原始 JSON。</div>';paint();}
function memoryBytes(value){const n=Number(value);return Number.isSafeInteger(n)?`${number(n)} B`:String(value)+' B';}
function argumentFactsHTML(event,supplied){
  const facts=supplied||extractArgumentFacts(event),ids=facts.ids;
  const buttons=[['tflite','TfliteID'],['flow','LinkId']].filter(([key])=>ids[key]!==undefined).map(([key,label])=>`<button class="soft-button" data-argument-focus="${key}" title="${esc(facts.sources[key])}">分析同 ${label} ${esc(ids[key])}</button>`).join('');
  if(!buttons&&!facts.memories.length&&!facts.warnings.length)return '';
  return `<section class="argument-facts"><h3>事件欄位分析</h3><div class="argument-actions">${buttons}${facts.memories.length?'<button class="soft-button" data-argument-focus="memory">比對記憶體範圍</button>':''}</div>${facts.memories.length?`<div class="analysis-table-wrap"><table class="analysis-table"><thead><tr><th>Location／用途</th><th>起點 → 尾端（含）</th><th>區段大小</th><th>判讀依據</th></tr></thead><tbody>${facts.memories.map(memory=>`<tr><th>${esc(memory.location)}<small>${memory.role==='input'?'輸入':memory.role==='output'?'輸出':'未標示用途'}</small></th><td>${esc(memory.start)} → ${esc(memory.end)}</td><td>${esc(memoryBytes(memory.bytes))}${memory.sizeMatches===false?`<small class="warning">宣告 ${esc(memoryBytes(memory.declaredBytes))}，不一致</small>`:''}</td><td>${esc(memory.basis==='start-and-size'?'起點＋Size':memory.basis==='size-confirmed-exclusive'?'Size 證實原尾端不含':memory.basis==='size-confirmed-inclusive'?'Size 證實尾端包含':'尾端包含尚未驗證')}</td></tr>`).join('')}</tbody></table></div>`:''}${facts.conflicts.length?`<p class="warning">${facts.conflicts.length} 個識別欄位不一致，優先使用較直接的明確欄位。</p>`:''}${facts.warnings.map(warning=>`<p class="warning">${esc(warning)}</p>`).join('')}${facts.truncated?'<p class="warning">此事件部分欄位達解析上限；完整資料仍在下方原始 JSON。</p>':''}</section>`;
}
function focusArguments(kind,value){
  if(!state.info||state.analysisBusy)return;
  if(value!==undefined)argumentFocus={kind,value};
  else if(state.detail){const facts=state.detail.facts||extractArgumentFacts(state.detail.event),event=state.detail.event;
    argumentFocus=kind==='memory'?{kind,pid:event.pid??0,core:facts.ids.core,memories:facts.memories,sourceOffset:state.selected.offset,ts:state.selected.ts,dur:state.selected.dur,crossProcess:false}:{kind,value:facts.ids[kind]};
  }else return;
  $('argument-focus').textContent=kind==='memory'?'目前事件的記憶體範圍':`${kind==='tflite'?'TfliteID':'LinkId'} ${argumentFocus.value}`;
  $('argument-cross-label').hidden=kind!=='memory';$('argument-cross-process').checked=false;$('include-arguments').checked=true;setView('insights');runAnalysis();
}
function renderDetail(focusSelector){
  const d=state.detail;if(!d||!state.selected)return;const content=$('details-content'),scrollTop=content.scrollTop,openGroups=new Set([...(content.querySelectorAll?.('.relation-group[open]')||[])].map(group=>group.getAttribute('data-relation-group')));const e=d.event,r=state.selected,t=state.info.tracks[r.trackId],name=missingEventName(e)?fallbackEventName(e,t,state.info.processes):e.name;$('selection-heading').textContent=name;$('selection-badge').textContent=r.n>1?`聚合 ${r.n} 筆 · 顯示代表事件`:'EVENT DETAILS';
  const extras=Object.fromEntries(Object.entries(e).filter(([key])=>!['name','ph','pid','tid','ts','dur','cat','args'].includes(key)));
  const links=d.links,linkType={address:'位址',symbol:'符號',flow:'Flow'},groups=groupRelationCandidates(state.links,state.info.tracks,state.info.processes),filtered=relationCandidates(),keys=[...new Map(state.links.flatMap(link=>relationAssociations(link).map(item=>[relationKey(item),item]))).entries()];
  const linkHTML=links?.keys.length?`<section class="relation-section"><div class="relation-top"><b>⌁ 位址與事件關聯 <small>${number(links.matches.length)} 筆候選${links.sampled?'（已取樣）':links.capped?'（已達顯示上限）':''}</small></b>
    <label class="relation-mode">連線<select data-relation-mode aria-label="關聯連線顯示"><option value="manual" ${relationMode==='manual'?'selected':''}>按需連線（預設）</option><option value="compact" ${relationMode==='compact'?'selected':''}>前後明確關聯（最多 2）</option><option value="more" ${relationMode==='more'?'selected':''}>更多（最多 16）</option></select></label><button class="text-button" id="show-relations">${state.showLinks?'隱藏關聯標示':'顯示關聯標示'}</button></div>
    <div class="relation-keys">${links.keys.map(k=>`<span class="relation-key">${linkType[k.type]} ${esc(k.key)} <span style="opacity:.6">${esc(k.path)}</span></span>`).join('')}</div>
    <div class="relation-filters"><label>範圍<select data-relation-scope aria-label="關聯核心分組"><option value="">全部核心／程序</option>${groups.map(group=>`<option value="${esc(group.id)}" ${group.id===relationScope?'selected':''}>${esc(group.label)} · ${group.links.length}</option>`).join('')}</select></label><label>關聯鍵<select data-relation-key aria-label="關聯鍵篩選"><option value="">全部關聯鍵</option>${keys.map(([key,link])=>`<option value="${esc(key)}" ${key===relationKeyFilter?'selected':''}>${linkType[link.relation.type]} ${esc(link.relation.key)}</option>`).join('')}</select></label>${relationFocus?'<button class="text-button" data-relation-reset>清除單筆連線</button>':''}</div>
    <div class="relation-list">${groupRelationCandidates(filtered,state.info.tracks,state.info.processes).map(group=>`<details class="relation-group" data-relation-group="${esc(group.id)}" ${relationScope||groups.length===1||openGroups.has(group.id)?'open':''}><summary>${esc(group.label)} · ${group.links.length} 筆／${group.trackCount} 軌道</summary><div class="relation-members">${group.links.map(m=>{const i=state.links.findIndex(link=>relationRecordKey(link.record)===relationRecordKey(m.record));return `<div class="relation-candidate"><button class="relation-item" data-relation="${i}"><span>${esc(m.record.label)}<small>${m.relation.type==='address'?'相同位址':`${esc(m.relation.role)} → ${esc(m.otherRole)}`} · ${esc(trackName(state.info.tracks[m.record.trackId]))}</small></span><span class="relation-time">${formatTime(m.record.ts-state.info.start,true)} ↗</span></button><button class="text-button relation-preview" data-relation-preview="${i}" aria-pressed="${relationFocus===relationRecordKey(m.record)}" aria-label="只顯示與 ${esc(m.record.label)} 的連線">連線</button></div>`;}).join('')}</div></details>`).join('')||'<span class="relation-empty">此範圍沒有其他候選事件。</span>'}</div>
    <p class="relation-help">預設只標記候選。點「連線」單獨查看一筆，再點可取消（目標須在時間窗內）；也可選前後明確關聯，最多 2 條 Flow／define-use，或「更多」最多 16 條。縮小至事件不足 4 px 時隱藏自動連線；聚合區段請放大。同址以外框標示，不代表因果。候選按程序／核心分組，最多 64 筆；明確標記優先，同址從時間附近的索引參照取樣，不是完整依賴圖。</p></section>`:'<section class="relation-section"><span style="font-size:14px;color:var(--muted)">此事件未找到可辨識的 address / ptr、defines / uses 或標準 flow ID。</span></section>';
  const custom=extensionHost.eventFields(e,{record:r,track:t}),extensionErrors=[...(extensionHost.startupErrors||[]),...custom.errors];
  const summary=[...eventSummary(e),...custom.fields],summaryHTML=summary.length?`<table class="event-fields"><caption>Trace 欄位摘要</caption><tbody>${summary.map(field=>`<tr title="${esc(field.path)}"><th scope="row">${esc(field.label)}</th><td>${esc(field.value)}</td></tr>`).join('')}</tbody></table>`:'';
  $('details-content').innerHTML=`<div class="event-summary"><h3>${esc(name)}</h3><span class="category-badge">${esc(e.cat||'uncategorized')} · ph=${esc(e.ph||'?')}</span><dl>${r.kind===2?`<dt>數值</dt><dd>${esc(formatCounterValue(r.value))}</dd>`:`<dt>持續時間</dt><dd>${formatTime(r.dur||0)}</dd>`}<dt>相對起點</dt><dd>${formatTime(r.ts-state.info.start)}</dd><dt>原始時間戳</dt><dd>${esc(e.ts)} µs</dd><dt>Process</dt><dd>${esc(state.info.processes[e.pid]||e.pid)}</dd><dt>軌道</dt><dd>${esc(t?trackName(t):e.tid)} · ${esc(e.tid)}</dd></dl></div><div>${summaryHTML}${argumentFactsHTML(e,d.facts)}${extensionErrors.map(error=>`<p class="warning">${esc(error.title)}：${esc(error.message)}</p>`).join('')}<details class="arguments-section" open><summary>原始 Arguments · ${Object.keys(e.args||{}).length} 欄位</summary><div class="json-tree">${Object.keys(e.args||{}).length?tree(e.args):'<span class="json-key">此事件沒有 args。</span>'}${Object.keys(extras).length?`<details open><summary>其他原始欄位</summary>${tree(extras)}</details>`:''}${d.endEvent?`<details open><summary>配對的 E 事件</summary>${tree(d.endEvent)}</details>`:''}</div></details><details class="raw-details" open><summary>完整原始 JSON</summary><pre>${esc(d.rawText)}</pre></details></div>${linkHTML}`;content.scrollTop=scrollTop;if(focusSelector)content.querySelector?.(focusSelector)?.focus({preventScroll:true});
}
function showArea(start,end,trackIds){state.detailId++;send('cancelDetail');if($('details').contains?.(document.activeElement))focusTimeline();state.selected=null;state.detail=null;state.links=[];state.area={start:Math.min(start,end),end:Math.max(start,end),trackIds};setDetailsVisible(true);$('selection-status').textContent=`已選取 ${formatTime(Math.abs(end-start))} 的時間範圍，${trackIds.length} 條軌道。`;$('selection-heading').textContent='時間範圍';$('selection-badge').textContent='AREA SELECTION';$('details-content').innerHTML=`<div class="event-summary"><h3>${formatTime(state.area.end-state.area.start)}</h3><span class="category-badge">${trackIds.length} 條軌道</span><dl><dt>起點</dt><dd>${formatTime(state.area.start-state.info.start)}</dd><dt>終點</dt><dd>${formatTime(state.area.end-state.info.start)}</dd></dl></div><div><div class="args-header"><b>範圍選取</b></div><p style="font-size:14px;color:var(--muted);line-height:2">按 F 聚焦這段時間。拖曳兩側邊界可以調整範圍。範圍時間是牆鐘時間，不等同於 CPU 耗時。</p><button class="soft-button" id="area-focus">⤢ 聚焦範圍 <kbd>F</kbd></button></div>`;paint();}
function renderEventRows(element,rows,note,search){
  element.innerHTML=`<div class="results-note">${esc(note)}</div>`+(rows.length?rows.map((r,i)=>`<button class="event-row" data-result="${i}" data-source="${search?'search':'top'}"><span class="rank">${String(i+1).padStart(2,'0')}</span><span><b>${esc(r.label||state.info?.names?.[r.name]||'')}</b><small>${esc(state.info?.tracks[r.trackId]?.name||'')} · PID ${esc(state.info?.tracks[r.trackId]?.pid)}</small></span><span class="time">${formatTime(r.dur,true)}${!search?`<div class="duration-bar" style="width:${Math.max(2,r.dur/rows[0].dur*100)}%"></div>`:''}</span><span class="time" style="color:var(--muted)">${formatTime(r.ts-state.info.start,true)} ↗</span></button>`).join(''):'<p class="empty-state">沒有符合的事件。試試不同的關鍵字。</p>');
}
function navigateRecord(r){setView('timeline');if(state.filter){state.filter='';$('track-filter').value='';updateLayout();}selectRecord(r,true);focusSelection();focusTimeline();}
function search(){const term=$('search-input').value.trim();if(!state.info||!term)return;state.searchId++;$('cancel-search').hidden=false;searchResults=[];$('search-results').innerHTML='<p class="empty-state">正在背景搜尋磁碟索引；必要時讀取原始名稱…</p>';send('search',{requestId:state.searchId,term});}
function setAnalysisBusy(busy){state.analysisBusy=busy;$('run-analysis').disabled=busy||!state.info;$('cancel-analysis').hidden=!busy;$('export-analysis').disabled=busy||!state.analysis;}
function runAnalysis({memberOffset=0,scopeOverride=null}={}){
  if(!state.info||state.analysisBusy)return;if(comparisonBusy){toast('請先完成或取消 Trace 比較。');return;}const windowed=$('analysis-scope').value==='window',thresholdUs=Number($('analysis-threshold').value)*1000;
  if(!Number.isFinite(thresholdUs)||thresholdUs<0){toast('請輸入有效的長事件門檻。');return;}
  const group=allGroups(state.groups).find(g=>g.id===$('analysis-group').value);let ids=(windowed?state.tracks:state.info.tracks).filter(t=>t.count>0).map(t=>t.id);
  if(group){const allowed=new Set(group.tracks.map(t=>t.id));ids=ids.filter(id=>allowed.has(id));}if(scopeOverride)ids=scopeOverride.trackIds;
  state.analysisId++;state.analysis=null;$('analysis-results').innerHTML='';setAnalysisBusy(true);$('analysis-status').textContent='正在背景掃描索引，可切回時間軸繼續操作。';
  if(argumentFocus?.kind==='memory')argumentFocus.crossProcess=$('argument-cross-process').checked;
  send('analysis',{requestId:state.analysisId,start:scopeOverride?.start??(windowed?state.start:state.info.start),end:scopeOverride?.end??(windowed?state.end:state.info.end),trackIds:ids,thresholdUs:scopeOverride?.thresholdUs??thresholdUs,includeArguments:$('include-arguments').checked,argumentFocus,memberOffset});
}
function renderArgumentReport(data,table){
  if(!data)return '';
  const title=data.focus?data.focus.kind==='memory'?`記憶體範圍候選 · ${data.focus.crossProcess?'所有程序／核心':'相同程序／核心'}`:`同 ${data.focus.kind==='tflite'?'TfliteID':'LinkId'} ${data.focus.value}`:'TfliteID／LinkId／Memory 彙整';
  const groups=(kind,label)=>table(label,['ID','事件數','核心／程序','範圍內累計時間','起點 → 終點','記憶體區段'],data.groups[kind].map(group=>`<tr><th><button class="analysis-name" data-argument-kind="${kind}" data-argument-id="${esc(group.id)}">${esc(group.id)} ↗</button></th><td>${number(group.count)}</td><td>${esc(group.cores.length?'核心 '+group.cores.join(', '):'PID '+group.pids.join(', '))}</td><td>${formatTime(group.totalUs,true)}</td><td>${formatTime(group.start-state.info.start,true)} → ${formatTime(group.end-state.info.start,true)}</td><td>${number(group.memories)}</td></tr>`));
  const order={before:'在來源之前',after:'在來源之後','overlap-time':'時間重疊',unknown:'時序未知'};
  const matches=data.focus?table(`符合事件 · ${data.matched?data.memberOffset+1:0}–${Math.min(data.matched,data.memberOffset+data.members.length)} / ${number(data.matched)}`,['事件','程序／核心','TfliteID／LinkId','來源起點','比對依據'],data.members.map((member,i)=>`<tr><th><button class="analysis-name" data-argument-member="${i}">${esc(member.record.label)} ↗</button></th><td>${esc(member.pid)}${member.core!==null?' / c'+esc(member.core):''}</td><td>${esc(member.ids.tflite??'—')} / ${esc(member.ids.flow??'—')}</td><td>${formatTime(member.record.ts-state.info.start,true)}</td><td>${member.matches.map(match=>match.kind==='same-id'?esc(match.path):`${match.kind==='same'?'同範圍':'重疊'} ${esc(memoryBytes(match.bytes))} · ${esc(match.location)} · ${esc(order[match.order])}${match.direction==='output-input'?' · 來源輸出→候選輸入':match.direction==='input-output'?' · 候選輸出→來源輸入':''}`).join('<br>')}</td></tr>`))+`<div class="argument-actions">${data.memberOffset?`<button class="soft-button" data-argument-page="${Math.max(0,data.memberOffset-100)}">上一頁</button>`:''}${data.hasMore?`<button class="soft-button" data-argument-page="${data.memberOffset+100}">下一頁（背景掃描）</button>`:''}<small>依索引掃描順序列出，每頁 100 筆；可縮小時間範圍與群組。</small></div>`:'';
  return `<section class="argument-report"><h2>事件 Args 分析</h2><p><b>${esc(title)}</b> · 已讀 ${number(data.events)} 個事件、${number(data.withIds)} 筆帶識別欄位、${number(data.memoryRanges)} 個記憶體區段 · ${data.reused?`已使用分析快取（原掃描 ${data.analysisSeconds.toFixed(2)} 秒）`:`${data.analysisSeconds.toFixed(2)} 秒`}</p>${data.truncatedFacts||data.conflicts||data.warnings||data.omittedGroupEvents||data.omittedLocationRanges?`<p class="warning">解析達上限 ${number(data.truncatedFacts)} 筆；欄位不一致 ${number(data.conflicts)} 項；記憶體警示 ${number(data.warnings)} 項；超出彙整上限 ${number(data.omittedGroupEvents)} 筆識別欄位／${number(data.omittedLocationRanges)} 個區段。</p>`:''}<p class="analysis-note">${data.notes.map(esc).join(' ')}${data.focus?' 下方分組與記憶體統計僅包含符合條件的事件。':''}</p>${matches}${groups('tflite','同 TfliteID 事件集合 · 前 100 組')}${groups('flow','同 LinkId 事件集合 · 前 100 組')}${table('MemoryRanges 彙整 · 前 100 組',['程序／核心','記憶體空間','區段數','輸入／輸出','宣告 Size 累計（含重用）','Size 不符'],data.locations.slice(0,100).map(location=>`<tr><th>${esc(location.pid)}${location.core!==''?' / c'+esc(location.core):''}</th><td>${esc(location.space)}</td><td>${number(location.count)}</td><td>${number(location.inputs)} / ${number(location.outputs)}</td><td>${esc(memoryBytes(location.declaredBytes))}</td><td>${number(location.sizeMismatches)}</td></tr>`))}</section>`;
}
function renderAnalysis(){
  const result=state.analysis;if(!result)return;
  $('analysis-status').textContent=`${result.analysisSeconds.toFixed(2)} 秒 · ${result.scope.trackIds.length} 條軌道 · ${formatTime(result.scope.start-state.info.start,true)} — ${formatTime(result.scope.end-state.info.start,true)} · 長事件門檻 ${formatTime(result.scope.thresholdUs,true)}`;
  const map=new Map(result.tracks.map(t=>[t.trackId,t]));
  const groups=allGroups(state.groups).filter(g=>g.children.every(child=>!child.children)).map(g=>{
    const matches=g.tracks.map(t=>map.get(t.id)).filter(Boolean);return {label:g.label+(g.id.startsWith('counter-')?' · 數值曲線':''),count:matches.reduce((n,t)=>n+t.count,0),samples:matches.reduce((n,t)=>n+t.counters,0),totalUs:matches.reduce((n,t)=>n+t.totalUs,0)};
  }).filter(g=>g.count||g.samples).sort((a,b)=>b.totalUs-a.totalUs);
  const table=(heading,columns,rows)=>`<section class="analysis-section"><h3>${heading}</h3><div class="analysis-table-wrap"><table class="analysis-table"><thead><tr>${columns.map(c=>`<th scope="col">${c}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${columns.length}">這個範圍沒有符合資料。</td></tr>`}</tbody></table></div></section>`;
  const extensions=[...(result.extensions||[]),...(result.extensionErrors||[]).map(error=>({...error,status:'error'}))];
  $('analysis-results').innerHTML=`<div class="analysis-stats"><div><span>區段數量</span><strong>${number(result.complete)}</strong><small>另有 ${number(result.markers)} 標記／${number(result.counters)} 數值樣本</small></div><div><span>累計區段時間（含重疊）</span><strong>${formatTime(result.totalUs,true)}</strong><small>不等於使用率或 self time</small></div><div><span>達門檻的長事件</span><strong>${number(result.longEvents)}</strong><small>最長 ${formatTime(result.maxUs,true)}</small></div><div><span>P95 近似上界</span><strong>≈ ${formatTime(result.p95UpperUs,true)}</strong><small>對數分桶估計</small></div></div><p class="analysis-note">${result.notes.map(esc).join(' ')}</p>`+
    table('各核心／程序', ['群組','區段數','數值樣本','累計時間（含重疊）'],groups.slice(0,100).map(g=>`<tr><th scope="row">${esc(g.label)}</th><td>${number(g.count)}</td><td>${number(g.samples)}</td><td>${formatTime(g.totalUs,true)}</td></tr>`))+
    table('事件名稱排行 · 前 100 筆',['事件名稱','次數','累計時間','平均','最長'],result.byName.map((row,i)=>`<tr><th scope="row"><button class="analysis-name" data-analysis-name="${i}" title="搜尋此事件">${esc(row.label)} ↗</button></th><td>${number(row.count)}</td><td>${formatTime(row.totalUs,true)}</td><td>${formatTime(row.averageUs,true)}</td><td>${formatTime(row.maxUs,true)}</td></tr>`))+
    table('最長區段定位 · 前 50 筆',['事件','來源軌道','範圍內持續時間','起點'],result.longest.map((item,i)=>`<tr><th scope="row"><button class="analysis-name" data-analysis-record="${i}">${esc(item.record.label)} ↗</button></th><td>${esc(trackName(state.info.tracks[item.record.trackId]))}</td><td>${formatTime(item.clippedUs,true)}</td><td>${formatTime(item.record.ts-state.info.start,true)}</td></tr>`))+
    table('各軌道累計時間 · 前 100 筆',['軌道','區段數','累計時間','最長'],result.tracks.slice(0,100).map(row=>`<tr><th scope="row">${esc(trackName(state.info.tracks[row.trackId]))}</th><td>${number(row.count)}</td><td>${formatTime(row.totalUs,true)}</td><td>${formatTime(row.maxUs,true)}</td></tr>`))+
    renderArgumentReport(result.arguments,table)+extensions.map(extension=>`<section class="analysis-section"><h3>${esc(extension.title)}</h3>${extension.status==='error'?`<p class="warning">擴充失敗：${esc(extension.message)}</p>`:`<p class="analysis-note">${esc(extension.summary)}</p><table class="event-fields"><tbody>${extension.rows.map(row=>`<tr><th>${esc(row.label)}</th><td>${esc(row.value)}</td></tr>`).join('')}</tbody></table>`}</section>`).join('');
}
$('analysis-form').onsubmit=e=>{e.preventDefault();runAnalysis();};
$('clear-argument-focus').onclick=()=>{argumentFocus=null;$('argument-focus').textContent='全部事件';$('argument-cross-label').hidden=true;};
$('cancel-analysis').onclick=()=>{send('cancelAnalysis');$('analysis-status').textContent='正在取消分析…';};
$('analysis-results').onclick=e=>{const group=e.target.closest('[data-argument-kind]'),member=e.target.closest('[data-argument-member]'),page=e.target.closest('[data-argument-page]');if(group){focusArguments(group.dataset.argumentKind,group.dataset.argumentId);return;}if(member){const record=state.analysis?.arguments?.members[Number(member.dataset.argumentMember)]?.record;if(record)navigateRecord(record);return;}if(page&&state.analysis?.arguments){const previous=state.analysis;argumentFocus=previous.arguments.focus;$('include-arguments').checked=true;runAnalysis({memberOffset:Number(page.dataset.argumentPage),scopeOverride:previous.scope});return;}const record=e.target.closest('[data-analysis-record]'),name=e.target.closest('[data-analysis-name]');if(record){const r=state.analysis?.longest[Number(record.dataset.analysisRecord)]?.record;if(r)navigateRecord(r);}else if(name){const label=state.analysis?.byName[Number(name.dataset.analysisName)]?.label;if(label){setView('events');$('search-input').value=label;search();}}};
$('export-analysis').onclick=()=>{if(!state.analysis)return;const blob=new Blob([JSON.stringify({version:1,source:state.info.source,...state.analysis},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='trace-analysis.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
function localPoint(e){const r=$('timeline').getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
$('timeline').addEventListener('pointerdown',e=>{
  if(!state.info||e.button!==0)return;$('tracks-scroll').focus({preventScroll:true});const p=localPoint(e);
  let edge=null;if(state.area&&!e.shiftKey){if(Math.abs(p.x-xTime(state.area.start))<8)edge='start';else if(Math.abs(p.x-xTime(state.area.end))<8)edge='end';}
  pointer={...p,clientX:e.clientX,clientY:e.clientY,start:state.start,end:state.end,mode:e.shiftKey?'pan':edge?'edge':'area',edge,moved:false};$('timeline').setPointerCapture(e.pointerId);$('tooltip').hidden=true;
});
$('timeline').addEventListener('pointermove',e=>{
  const p=localPoint(e);
  if(pointer){if(Math.abs(p.x-pointer.x)+Math.abs(p.y-pointer.y)>4)pointer.moved=true;
    if(pointer.mode==='pan'){const delta=(p.x-pointer.x)/plotWidth*(pointer.end-pointer.start);setRange(pointer.start-delta,pointer.end-delta);}
    else if(pointer.moved){const start=pointer.mode==='edge'?state.area.start:timeX(pointer.x),end=pointer.mode==='edge'?state.area.end:timeX(p.x);const edgeTime=timeX(Math.max(0,Math.min(plotWidth,p.x)));const top=$('tracks-scroll').scrollTop;
      const ids=[...new Set(state.layout.filter(r=>r.y+r.h>=top+Math.min(pointer.y,p.y)&&r.y<=top+Math.max(pointer.y,p.y)).flatMap(r=>r.type==='group'?r.trackIds:[r.track.id]))];
      showArea(pointer.mode==='edge'&&pointer.edge==='start'?edgeTime:start,pointer.mode==='edge'&&pointer.edge==='end'?edgeTime:end,pointer.mode==='edge'?state.area.trackIds:ids);
    }return;
  }
  const hit=hitboxes.findLast(h=>p.x>=h.x&&p.x<=h.x+h.w&&p.y>=h.y&&p.y<=h.y+h.h);
  if(hit){$('tooltip').innerHTML=hit.groupId?`${esc(hit.label)}<small>${hit.count} 條軌道的摘要概覽；點選展開，非精確事件數或使用率。</small>`:`${esc(hit.record.label)}<small>${formatTime(hit.record.dur||0)}${hit.record.kind===2?` · value ${hit.record.value.toFixed(2)}`:''}${hit.record.aggregated?' · 依畫素保留首尾與極值，點選為原始樣本':hit.record.n>1?` · 聚合 ${hit.record.n} 筆，放大可展開`:''}</small>`;$('tooltip').hidden=false;$('tooltip').style.left=`${Math.max(8,Math.min(innerWidth-350,e.clientX+14))}px`;$('tooltip').style.top=`${Math.min(innerHeight-80,e.clientY+15)}px`;}else $('tooltip').hidden=true;
});
$('timeline').addEventListener('pointerup',e=>{if(!pointer)return;const p=localPoint(e);if(!pointer.moved){const hit=hitboxes.findLast(h=>p.x>=h.x&&p.x<=h.x+h.w&&p.y>=h.y&&p.y<=h.y+h.h);if(hit?.groupId)toggleGroup(hit.groupId);else if(hit)selectRecord(hit.record);else clearSelection();}pointer=null;});
$('timeline').addEventListener('pointercancel',()=>pointer=null);$('timeline').addEventListener('pointerleave',()=>$('tooltip').hidden=true);
$('timeline').addEventListener('dblclick',()=>focusSelection());
$('tracks-scroll').addEventListener('wheel',e=>{if(!state.info)return;if(e.ctrlKey||e.metaKey){e.preventDefault();zoom(1-wheelZoomRatio(e.deltaY),Math.max(0,Math.min(1,(e.clientX-$('timeline').getBoundingClientRect().left)/plotWidth)));}else if(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)){e.preventDefault();pan((e.deltaX||e.deltaY)/plotWidth);}},{passive:false});
$('tracks-scroll').addEventListener('scroll',()=>{runtimeMetrics.intent();renderLabels();requestQuery();},{passive:true});
$('overview-wrap').addEventListener('pointerdown',e=>{if(!state.info)return;overviewPointer={x:e.clientX,start:state.start,span:state.end-state.start};e.currentTarget.setPointerCapture(e.pointerId);const r=e.currentTarget.getBoundingClientRect(),t=state.info.start+(e.clientX-r.left)/r.width*(state.info.end-state.info.start);setRange(t-overviewPointer.span/2,t+overviewPointer.span/2);overviewPointer.start=state.start;});
$('overview-wrap').addEventListener('pointermove',e=>{if(!overviewPointer)return;const delta=(e.clientX-overviewPointer.x)/e.currentTarget.clientWidth*(state.info.end-state.info.start);setRange(overviewPointer.start+delta,overviewPointer.start+delta+overviewPointer.span);});
for(const evt of ['pointerup','pointercancel'])$('overview-wrap').addEventListener(evt,()=>overviewPointer=null);
function toggleTrackHeight(id){runtimeMetrics.intent();if(state.expanded.has(id))state.expanded.delete(id);else state.expanded.add(id);updateLayout();}
function toggleGroup(id){runtimeMetrics.intent();if(state.collapsed.has(id))state.collapsed.delete(id);else state.collapsed.add(id);updateLayout();}
$('track-labels').addEventListener('mousedown',e=>{if(e.detail===1)heightPointerClick=null;});
$('track-labels').addEventListener('click',e=>{const height=e.target.closest('[data-track-toggle]');if(height){const id=Number(height.dataset.trackToggle);if(e.detail>0)heightPointerClick=id;if(!(e.detail>1))toggleTrackHeight(id);return;}const group=e.target.closest('[data-group]');if(group){toggleGroup(group.dataset.group);return;}const pin=e.target.closest('[data-pin]');if(pin){const id=Number(pin.dataset.pin);runtimeMetrics.intent();if(state.pins.has(id))state.pins.delete(id);else state.pins.add(id);updateLayout();$('tracks-scroll').scrollTop=0;}});
$('track-labels').addEventListener('dblclick',e=>{if(e.target.closest('button'))return;const label=e.target.closest('[data-track]');if(label){const id=Number(label.dataset.track);if(heightPointerClick===id){heightPointerClick=null;return;}toggleTrackHeight(id);}});
$('track-filter').addEventListener('input',e=>{runtimeMetrics.intent();state.filter=e.target.value;updateLayout();});$('reset-filter').onclick=()=>{runtimeMetrics.intent();$('track-filter').value='';state.filter='';updateLayout();};
document.querySelectorAll('.nav').forEach(e=>e.onclick=()=>{setView(e.dataset.view);if(innerWidth<=900)applySidebar(true);});
$('open').onclick=()=>$('file').click();$('file').onchange=e=>{loadFiles(e.target.files);e.target.value='';};$('demo').onclick=loadDemo;
$('add-traces').onclick=()=>$('file').click();$('trace-tabs').onclick=e=>{const tab=e.target.closest('[data-trace-open]');if(tab)openSavedTrace(tab.dataset.traceOpen);};
$('open-comparison').onclick=openComparison;$('refresh-traces').onclick=refreshSavedTraces;
$('trace-cache-limit').value=String(cacheLimit);$('trace-cache-limit').onchange=e=>{if(comparisonBusy){e.target.value=String(cacheLimit);toast('請先完成或取消比較。');return;}cacheLimit=Number(e.target.value);try{localStorage.setItem('trace-studio-cache-limit',String(cacheLimit));}catch{}send('cachePolicy',{limitMB:cacheLimit});refreshSavedTraces();};
$('comparison-sources').onchange=e=>{const id=e.target.dataset.comparisonId;if(!id)return;if(e.target.checked){if([...comparisonIds].filter(id=>savedTraces.some(item=>item.id===id)).length>=3){e.target.checked=false;toast('最多比較三份 Trace。');return;}comparisonIds.add(id);}else comparisonIds.delete(id);};
$('comparison-form').onsubmit=e=>{e.preventDefault();if(comparisonBusy||importing)return;if(state.analysisBusy){toast('請先完成或取消 Trace 分析。');return;}const ids=[...comparisonIds].filter(id=>savedTraces.some(item=>item.id===id));if(ids.length<2||ids.length>3){toast('請選擇 2–3 份 Trace。');return;}saveTraceView();const scopes={};if($('comparison-range').value==='saved')for(const id of ids){const view=traceViews.get(id);if(!view){toast('請先開啟各份 Trace 並調整要比較的時間範圍。');return;}scopes[id]={start:view.start,end:view.end};}comparisonResult=null;setComparisonBusy(true);$('comparison-results').innerHTML='';$('comparison-status').textContent='正在背景比較，可切回時間軸繼續操作。';send('compare',{requestId:++comparisonRequest,ids,scopes,sourceNames:Object.fromEntries(savedTraces.map(item=>[item.id,item.name])),tfliteId:$('comparison-id').value});};
$('cancel-comparison').onclick=()=>send('cancelAnalysis');
$('comparison-results').onclick=e=>{const operator=e.target.closest('[data-compare-id]');if(operator){$('comparison-id').value=operator.dataset.compareId;$('comparison-form').onsubmit({preventDefault(){}});return;}const button=e.target.closest('[data-compare-member]');if(!button||!comparisonResult)return;const [traceIndex,memberIndex]=button.dataset.compareMember.split(':').map(Number),trace=comparisonResult.traces[traceIndex],record=trace?.members?.[memberIndex]?.record;if(record)openSavedTrace(trace.id,record);};
$('export-comparison').onclick=()=>{if(!comparisonResult)return;const url=URL.createObjectURL(new Blob([JSON.stringify(comparisonResult,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='trace-comparison.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
window.addEventListener('pagehide',saveTraceView);
$('runtime-toggle').onclick=()=>{if(runtimeMetrics.enabled)runtimeMetrics.stop();else runtimeMetrics.start();renderRuntimeMetrics();};
$('runtime-reset').onclick=()=>{runtimeMetrics.reset();renderRuntimeMetrics();};
$('runtime-refresh').onclick=renderRuntimeMetrics;
document.addEventListener('visibilitychange',()=>runtimeMetrics.visibilityChanged());
$('runtime-copy').onclick=async()=>{const text=JSON.stringify(runtimeReport(),null,2);$('runtime-json').value=text;try{await navigator.clipboard.writeText(text);toast('效能報告已複製，不含檔名或事件內容。');}catch{toast('無法寫入剪貼簿，請展開效能報告 JSON 手動複製。');}};
$('zoom-in').onclick=()=>zoom(.65);$('zoom-out').onclick=()=>zoom(1/.65);$('fit').onclick=fitAll;$('focus-selection').onclick=focusSelection;
$('toggle-details').onclick=toggleDetails;
$('close-details').onclick=()=>setDetailsVisible(false);
let drawerDrag=null;
function drawerMaxHeight(){const details=$('details').getBoundingClientRect(),tracks=$('tracks-scroll').getBoundingClientRect();return Math.max(100,Math.min(innerHeight*.6,details.height+tracks.height-100));}
function describeDrawer(){if($('details').hidden)return;const height=Math.round($('details').getBoundingClientRect().height),handle=$('details-resize');handle.setAttribute('aria-valuemin','100');handle.setAttribute('aria-valuemax',String(Math.round(drawerMaxHeight())));handle.setAttribute('aria-valuenow',String(height));handle.setAttribute('aria-valuetext',`${height} 像素高`);}
function resizeDrawer(height){$('timeline-view').style.setProperty('--drawer-height',`${Math.max(100,Math.min(drawerMaxHeight(),height))}px`);describeDrawer();}
$('details-resize').addEventListener('pointerdown',e=>{drawerDrag={y:e.clientY,height:$('details').getBoundingClientRect().height};e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault();});
$('details-resize').addEventListener('pointermove',e=>{if(drawerDrag)resizeDrawer(drawerDrag.height+drawerDrag.y-e.clientY);});
for(const event of ['pointerup','pointercancel'])$('details-resize').addEventListener(event,()=>drawerDrag=null);
$('details-resize').addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();e.stopPropagation();resizeDrawer($('details').getBoundingClientRect().height+(e.key==='ArrowUp'?20:-20));}});
$('expand-groups').onclick=()=>{runtimeMetrics.intent();state.collapsed.clear();updateLayout();};
$('collapse-groups').onclick=()=>{runtimeMetrics.intent();state.collapsed=new Set(allGroups(state.groups).map(group=>group.id));updateLayout();$('tracks-scroll').scrollTop=0;};
function applyDensity(){document.body.classList.toggle('density-compact',state.density==='compact');$('density-toggle').textContent=state.density==='compact'?'緊湊':'舒適';$('density-toggle').setAttribute('aria-pressed',String(state.density==='compact'));updateLayout();}
$('density-toggle').onclick=()=>{runtimeMetrics.intent();state.density=state.density==='compact'?'comfortable':'compact';try{localStorage.setItem('trace-studio-density',state.density);}catch{}applyDensity();};
function applySidebar(collapsed){document.body.classList.toggle('sidebar-collapsed',collapsed);$('toggle-sidebar').setAttribute('aria-expanded',String(!collapsed));$('toggle-sidebar').setAttribute('aria-label',collapsed?'展開側欄':'收合側欄');$('toggle-sidebar').title=collapsed?'展開側欄':'收合側欄';}
$('toggle-sidebar').onclick=()=>{const collapsed=!document.body.classList.contains('sidebar-collapsed');applySidebar(collapsed);try{localStorage.setItem('trace-studio-sidebar',collapsed?'collapsed':'expanded');}catch{}};
$('close-sidebar').onclick=()=>{applySidebar(true);try{localStorage.setItem('trace-studio-sidebar','collapsed');}catch{}};
$('copy').onclick=async()=>{if(!state.detail){toast('請先選取事件。');return;}try{await navigator.clipboard.writeText(state.detail.rawText);toast('已複製原始事件 JSON。');}catch{toast('瀏覽器未允許剪貼簿存取，可展開原始 JSON 手動複製。');}};
$('details-content').addEventListener('click',e=>{const preview=e.target.closest('[data-relation-preview]');if(preview){const link=state.links[Number(preview.dataset.relationPreview)];if(link){relationFocus=relationFocus===relationRecordKey(link.record)?null:relationRecordKey(link.record);state.showLinks=true;renderDetail(`[data-relation-preview="${preview.dataset.relationPreview}"]`);paint();}return;}if(e.target.closest('[data-relation-reset]')){relationFocus=null;renderDetail('[data-relation-mode]');paint();return;}const argument=e.target.closest('[data-argument-focus]');if(argument){focusArguments(argument.dataset.argumentFocus);return;}const relation=e.target.closest('[data-relation]');if(relation){const r=state.links[Number(relation.dataset.relation)]?.record;if(r)navigateRecord(r);}if(e.target.closest('#show-relations')){state.showLinks=!state.showLinks;renderDetail('#show-relations');paint();}if(e.target.closest('#area-focus'))focusSelection();});
$('details-content').addEventListener('change',e=>{if(e.target.matches('[data-relation-mode]')){relationMode=['compact','more'].includes(e.target.value)?e.target.value:'manual';relationFocus=null;renderDetail('[data-relation-mode]');paint();}else if(e.target.matches('[data-relation-scope]')){relationScope=e.target.value;relationFocus=null;renderDetail('[data-relation-scope]');paint();}else if(e.target.matches('[data-relation-key]')){relationKeyFilter=e.target.value;relationFocus=null;renderDetail('[data-relation-key]');paint();}});
for(const id of ['search-results','insights-list'])$(id).addEventListener('click',e=>{const button=e.target.closest('[data-result]');if(button){const r=(button.dataset.source==='search'?searchResults:state.info.top)[Number(button.dataset.result)];navigateRecord(r);}});
$('search-form').onsubmit=e=>{e.preventDefault();search();};
$('cancel-search').onclick=()=>{send('cancelSearch');$('search-results').innerHTML='<p class="empty-state">正在取消搜尋…</p>';};
function openHelp(){if(!$('help').open)$('help').showModal();}
$('shortcuts').onclick=openHelp;$('help-link').onclick=openHelp;
document.querySelectorAll('[data-close]').forEach(e=>e.onclick=()=>$(e.dataset.close).close());
function renderCaches(){
  const pages=Math.max(1,Math.ceil(cacheEntries.length/25));cachePage=Math.min(cachePage,pages-1);
  $('cache-list').innerHTML=cacheEntries.slice(cachePage*25,(cachePage+1)*25).map(item=>`<div class="cache-entry"><div class="cache-description"><b title="${esc(item.name)}">${esc(item.name)}</b><small>${bytes(item.bytes)} · ${item.current?'目前開啟':item.memory?'小檔索引快取':item.busy?'其他分頁使用中':item.complete?'可還原':'未完成'}${item.demo?' · 示範':''}${item.createdAt?` · ${esc(new Date(item.createdAt).toLocaleString())}`:''}</small></div><div class="cache-entry-actions"><button class="soft-button" data-cache-open="${item.id}" aria-label="開啟快取 ${esc(item.name)}" ${cacheBusy||item.current||item.busy&&!item.memory||!item.complete?'disabled':''}>開啟</button><button class="soft-button" data-cache-remove="${item.id}" aria-label="清除快取 ${esc(item.name)}" ${cacheBusy||item.current||item.busy&&!item.memory?'disabled':''}>清除</button></div></div>`).join('')||'<p class="empty-state">目前沒有 Trace 快取。</p>';
  $('cache-page').textContent=`${cachePage+1} / ${pages}`;$('cache-prev').disabled=cacheBusy||cachePage===0;$('cache-next').disabled=cacheBusy||cachePage===pages-1;
  for(const id of ['clear-cache','clear-unused','refresh-cache'])$(id).disabled=cacheBusy;
}
async function refreshCaches(){cacheBusy=true;renderCaches();$('cache-status').textContent='正在讀取快取清單…';send('sessions',{requestId:++cacheRequest});const q=await navigator.storage?.estimate?.().catch(()=>({}))||{};$('storage-usage').textContent=Number.isFinite(q.usage)?`本站已用 ${bytes(q.usage)}${Number.isFinite(q.quota)?` / 額度 ${bytes(q.quota)}`:''}`:'瀏覽器未提供儲存額度。';}
$('storage').onclick=()=>{$('cache-dialog').showModal();cachePage=0;refreshCaches();};
$('refresh-cache').onclick=refreshCaches;
$('cache-prev').onclick=()=>{cachePage=Math.max(0,cachePage-1);renderCaches();};$('cache-next').onclick=()=>{cachePage++;renderCaches();};
$('cache-list').addEventListener('click',e=>{if(cacheBusy)return;const open=e.target.closest('[data-cache-open]'),remove=e.target.closest('[data-cache-remove]');if(open){$('cache-dialog').close();beginLoading('正在開啟本機快取');send('restore',{id:open.dataset.cacheOpen});}else if(remove){cacheBusy=true;renderCaches();send('removeSession',{requestId:++cacheRequest,id:remove.dataset.cacheRemove});}});
$('clear-unused').onclick=()=>{cacheBusy=true;renderCaches();send('clearUnused',{requestId:++cacheRequest});};
$('clear-cache').onclick=()=>{cacheBusy=true;renderCaches();startWorker();send('clear');};
function cancelImport(){if(!importing||importCancelling)return;pendingFiles=[];importCancelling=true;$('cancel').disabled=true;$('loading-title').textContent='正在取消並清理未完成的索引…';send('cancelImport',{requestId:loadRequestId});}
$('cancel').onclick=cancelImport;
$('loading').addEventListener('cancel',e=>{e.preventDefault();cancelImport();});
$('theme').onclick=()=>{document.body.classList.toggle('dark');$('theme').setAttribute('aria-pressed',String(document.body.classList.contains('dark')));try{localStorage.setItem('trace-studio-theme',document.body.classList.contains('dark')?'dark':'light');}catch{}paint();drawOverview();};
const commands=[['開啟 Trace 檔案','O',()=>$('file').click()],['載入多核心示範','',loadDemo],['展開全部核心與程序','',()=>$('expand-groups').click()],['收合全部核心與程序','',()=>$('collapse-groups').click()],['切換緊湊／舒適列高','',()=>$('density-toggle').click()],['顯示完整 Trace','',fitAll],['聚焦目前選取','F',focusSelection],['放大時間軸','W',()=>zoom(.65)],['縮小時間軸','S',()=>zoom(1/.65)],['搜尋事件名稱','/',()=>setView('events')],['尋找軌道','Ctrl P',()=>{setView('timeline');$('track-filter').focus();}],['切換詳情面板','Q',toggleDetails],['切換深色模式','',()=>$('theme').click()],['Trace 資訊','',()=>setView('info')],['操作與快捷鍵','?',openHelp]];
function renderCommands(){const term=$('command-input').value.toLowerCase();filteredCommands=commands.filter(c=>c[0].toLowerCase().includes(term));commandIndex=Math.min(commandIndex,Math.max(0,filteredCommands.length-1));$('command-list').innerHTML=filteredCommands.map((c,i)=>`<button id="command-option-${i}" role="option" aria-selected="${i===commandIndex}" tabindex="-1" data-command="${i}" class="${i===commandIndex?'command-selected':''}"><span>${c[0]}</span><kbd>${c[1]||'↵'}</kbd></button>`).join('')||'<p class="empty-state">沒有符合的指令。</p>';if(filteredCommands.length)$('command-input').setAttribute('aria-activedescendant',`command-option-${commandIndex}`);else $('command-input').removeAttribute('aria-activedescendant');$('command-status').textContent=`${filteredCommands.length} 個符合的指令`;document.getElementById(`command-option-${commandIndex}`)?.scrollIntoView?.({block:'nearest'});}
function openCommands(){renderCommands();$('command-input').setAttribute('aria-expanded','true');$('commands').showModal();$('command-input').focus();}
$('commands').addEventListener('close',()=>$('command-input').setAttribute('aria-expanded','false'));
$('command-input').oninput=()=>{commandIndex=0;renderCommands();};$('command-input').onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();commandIndex=(commandIndex+(e.key==='ArrowDown'?1:-1)+filteredCommands.length)%Math.max(1,filteredCommands.length);renderCommands();}if(e.key==='Enter'){e.preventDefault();const command=filteredCommands[commandIndex];$('commands').close();command?.[2]();}};
$('command-list').onclick=e=>{const b=e.target.closest('[data-command]');if(b){$('commands').close();filteredCommands[Number(b.dataset.command)]?.[2]();}};
document.addEventListener('keydown',e=>{
  const modal=document.querySelector('dialog[open]');if(modal&&e.key==='Tab'){trapDialogTab(modal,e);return;}
  if(e.key==='Escape'){$('tooltip').hidden=true;if(!document.querySelector('dialog[open]')&&state.view==='timeline'){e.preventDefault();clearSelection();focusTimeline();}return;}
  const editing=/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable;
  if(document.querySelector('dialog[open]'))return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='p'){e.preventDefault();if(e.shiftKey)openCommands();else{setView('timeline');$('track-filter').focus();}return;}
  if(editing||e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key==='Enter'&&e.target===$('tracks-scroll')){e.preventDefault();if(queryBusy||queryTimer||queryDirty){toast('畫面正在更新，請稍後再選取事件。');return;}const first=hitboxes.find(box=>box.record&&box.x+box.w>=0&&box.x<=plotWidth&&box.y+box.h>=0&&box.y<=plotHeight);if(first)selectRecord(first.record);else toast('目前沒有可選事件，請先展開軌道或調整時間範圍。');return;}
  const key=e.key.toLowerCase();
  const handlers={f:focusSelection,q:toggleDetails,r:()=>{if(state.selected)showArea(state.selected.ts,state.selected.ts+state.selected.dur,[state.selected.trackId]);},o:()=>$('file').click(),'/':()=>setView('events'),'?':openHelp,'.':()=>{if(state.selected)send('neighbor',{record:state.selected,direction:1});},',':()=>{if(state.selected)send('neighbor',{record:state.selected,direction:-1});},'>':openCommands};
  if(handlers[key]){e.preventDefault();handlers[key]();}
});
let dragDepth=0;document.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;$('dropzone').hidden=false;}});document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('dropzone').hidden=true;}});document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('dropzone').hidden=true;if(importing){toast('請先完成或取消目前的匯入。');return;}loadFiles(e.dataTransfer.files);});
new PerfettoNavigation($('timeline'),{pan:px=>pan(px/plotWidth),zoom:(x,ratio)=>zoom(Math.max(.01,1-ratio),x===null?.5:Math.max(0,Math.min(1,x/plotWidth))),editable:e=>state.view!=='timeline'||!state.info||!!document.querySelector('dialog[open]')||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable});
new ResizeObserver(()=>{measure();renderLabels();requestQuery();}).observe($('tracks-scroll'));
try{if(localStorage.getItem('trace-studio-theme')==='dark')document.body.classList.add('dark');if(localStorage.getItem('trace-studio-density')==='comfortable')state.density='comfortable';applySidebar(localStorage.getItem('trace-studio-sidebar')!=='expanded');}catch{}$('theme').setAttribute('aria-pressed',String(document.body.classList.contains('dark')));applyDensity();
startWorker();const last=(()=>{try{return localStorage.getItem('trace-studio-session');}catch{return null;}})();if(last){beginLoading('從本機索引還原');send('restore',{id:last});}else loadDemo();
