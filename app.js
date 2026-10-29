import {PerfettoNavigation,wheelZoomRatio} from './navigation.js';
import {groupTracks,allGroups,defaultCollapsed,makeTrackLayout,revealTrack,trackName} from './track-layout.js?v=0.2.1';
import {eventSummary} from './event-summary.js';
import {eventColor} from './event-colors.js';
import {loadExtensionHost} from './extensions/runtime.js';
const extensionHost=await loadExtensionHost();
const $=id=>document.getElementById(id), esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={info:null,start:0,end:1,tracks:[],layout:[],rows:new Map(),groups:[],collapsed:new Set(),groupRows:new Map(),lanes:new Map(),density:'compact',pins:new Set(),expanded:new Set(),selected:null,detail:null,links:[],area:null,filter:'',view:'timeline',query:0,detailId:0,searchId:0,analysisId:0,analysis:null,analysisBusy:false,showLinks:true};
let worker,queryTimer,paintFrame,toastTimer,searchResults=[],commandIndex=0,filteredCommands=[],importing=false,queryBusy=false,queryDirty=false;
let importRecovery=null,restoringRecovery=null;
let labelWidth=250,plotWidth=700,plotHeight=420,hitboxes=[],pointer=null,overviewPointer=null;
const palette=['#a8c995','#aac4d9','#e3c489','#bcb2d2','#b4d7cd','#d9b7a8'];
function formatTime(us,short=false){const n=Math.abs(us);if(n>=1e6)return `${(us/1e6).toFixed(short?2:3)} s`;if(n>=1000)return `${(us/1000).toFixed(short?1:3)} ms`;return `${us.toFixed(n<1?2:1)} µs`;}
function bytes(n){return n>=1e9?`${(n/1e9).toFixed(2)} GB`:n>=1e6?`${(n/1e6).toFixed(1)} MB`:`${(n/1e3).toFixed(0)} KB`;}
function number(n){return n.toLocaleString('en-US');}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function send(type,data={}){worker.postMessage({type,...data});}
function startWorker(){worker?.terminate();queryBusy=false;queryDirty=false;clearTimeout(queryTimer);queryTimer=null;const active=new Worker(new URL('./worker.js?v=0.2.2',import.meta.url),{type:'module'});worker=active;active.onmessage=event=>{if(worker===active)handleMessage(event);};active.onerror=e=>{if(worker!==active)return;finishLoading();toast(`背景引擎錯誤：${e.message}`);};}
function finishLoading(){importing=false;if($('loading').open)$('loading').close();}
function beginLoading(title='正在讀取 Trace',remember=true){
  if(remember&&state.info)importRecovery={id:state.info.id,start:state.start,end:state.end,filter:state.filter,view:state.view,pins:new Set(state.pins),expanded:new Set(state.expanded),collapsed:new Set(state.collapsed),lanes:new Map(state.lanes),selected:state.selected,detail:state.detail,links:state.links,area:state.area,analysis:state.analysis,detailsHidden:$('details').hidden,scrollTop:$('tracks-scroll').scrollTop};
  importing=true;state.info=null;state.rows.clear();state.selected=null;state.links=[];state.area=null;state.detail=null;
  state.analysis=null;state.analysisId++;setAnalysisBusy(false);$('analysis-results').innerHTML='';$('export-analysis').disabled=true;
  $('loading-title').textContent=title;$('progress-bar').style.width='0%';$('progress-percent').textContent='0%';$('progress-bytes').textContent='準備磁碟索引…';$('progress-events').textContent='0';$('progress-rate').textContent='— MB/s';
  if(!$('loading').open)$('loading').showModal();
}
function recoverImport(message){
  const previous=importRecovery||restoringRecovery;if(!previous)return false;
  restoringRecovery={...previous,notice:message};importRecovery=null;beginLoading('正在還原上一份 Trace',false);toast(`${message} 正在還原上一份 Trace。`);send('restore',{id:previous.id});return true;
}
function loadFile(file){if(!file)return;if(!/\.(json|gz)$/i.test(file.name)){toast('目前支援 Chrome Trace JSON（.json / .json.gz），請先轉換其他格式。');return;}startWorker();beginLoading();send('import',{file});}
function loadDemo(){startWorker();beginLoading('正在準備多核心示範 Trace');send('hardwareDemo');}
function handleMessage({data}){
  switch(data.type){
    case 'progress':{
      const p=Math.min(99.9,data.bytes/Math.max(1,data.total)*100);$('progress-bar').style.width=`${p}%`;$('progress-percent').textContent=`${p.toFixed(1)}%`;
      $('progress-bytes').textContent=`${bytes(data.bytes)} / ${bytes(data.total)}`;$('progress-events').textContent=number(data.events);$('progress-rate').textContent=`${(data.bytes/1e6/Math.max(.01,data.elapsed)).toFixed(1)} MB/s`;break;
    }
    case 'ready':{
      const recovered=restoringRecovery?.id===data.info.id?restoringRecovery:null;restoringRecovery=null;importRecovery=null;
      state.info=data.info;state.start=data.info.start;state.end=data.info.end;state.selected=null;state.detail=null;state.links=[];state.pins.clear();state.expanded.clear();state.lanes.clear();state.rows.clear();state.groupRows.clear();state.groups=groupTracks(data.info.tracks,data.info.processes);state.collapsed=defaultCollapsed(state.groups);state.filter='';$('track-filter').value='';$('details').hidden=true;finishLoading();
      try{localStorage.setItem('trace-studio-session',data.info.id);}catch{}
      if(recovered){for(const key of ['start','end','filter','view','pins','expanded','collapsed','lanes','selected','detail','links','area','analysis'])state[key]=recovered[key];$('track-filter').value=state.filter;$('details').hidden=recovered.detailsHidden;}
      updateInfo(data.restored);setView(recovered?.view||'timeline');updateLayout();if(recovered){$('tracks-scroll').scrollTop=recovered.scrollTop;renderLabels();if(state.detail)renderDetail();if(state.analysis)renderAnalysis();else $('analysis-status').textContent='可重新選擇範圍並開始分析。';}drawOverview();requestQuery();
      if(!recovered&&!data.info.source.demo)toast(data.restored?'已從本機快取還原，不需重新解析。':`已完成索引：${number(data.info.count)} 筆事件，${data.info.importSeconds.toFixed(2)} 秒。`);
      if(recovered)toast(`${recovered.notice} 已返回上一份 Trace。`);
      break;
    }
    case 'query':{
      queryBusy=false;if(data.requestId===state.query){state.rows=new Map(data.rows.map(r=>[r.id,r.rows]));state.groupRows=new Map((data.groups||[]).map(r=>[r.id,r.bins]));
        let changed=false;for(const item of data.rows){const lanes=Math.min(4,item.rows.reduce((max,r)=>Math.max(max,1+(r.lane||0)),1));if(lanes>(state.lanes.get(item.id)||1)){state.lanes.set(item.id,lanes);changed=true;}}
        $('render-info').textContent=`${data.ms.toFixed(1)} ms · ${number(data.rows.reduce((n,r)=>n+r.rows.length,0))} 節點`;
        if(changed&&state.density==='compact')updateLayout();paint();
      }if(queryDirty){queryDirty=false;requestQuery();}break;
    }
    case 'detail':if(data.requestId===state.detailId){state.detail=data;state.links=data.links?.matches||[];renderDetail();paint();}break;
    case 'searchProgress':if(data.requestId===state.searchId)$('search-results').innerHTML=`<p class="empty-state">搜尋中… 已掃描 ${number(data.scanned)} 筆索引</p>`;break;
    case 'search':if(data.requestId===state.searchId){searchResults=data.results;renderEventRows($('search-results'),data.results,data.capped?'顯示前 100 筆符合結果。縮小關鍵字可找到更精確的事件。':`找到 ${number(data.results.length)} 筆事件。`,true);}break;
    case 'neighbor':if(data.record)selectRecord(data.record,true);else toast('已到達這條軌道的邊界。');break;
    case 'analysisProgress':if(data.requestId===state.analysisId)$('analysis-status').textContent=`背景分析中：${number(data.scanned)} / ${number(data.total)} 筆索引，已找到 ${number(data.complete)} 個區段，${data.elapsed.toFixed(1)} 秒。時間軸仍可操作。`;break;
    case 'analysis':if(data.requestId===state.analysisId){state.analysis=data.result;setAnalysisBusy(false);renderAnalysis();}break;
    case 'analysisCancelled':if(data.requestId===state.analysisId){setAnalysisBusy(false);$('analysis-status').textContent='分析已取消，trace 保留。';}break;
    case 'cleared':try{localStorage.removeItem('trace-studio-session');}catch{}state.info=null;importRecovery=null;restoringRecovery=null;$('cache-dialog').close();toast('Trace 快取已清除。');loadDemo();break;
    case 'error':{
      finishLoading();toast(data.message);
      if(data.operation==='query'){queryBusy=false;queryDirty=false;}
      if(data.operation==='analysis'&&data.requestId===state.analysisId){setAnalysisBusy(false);$('analysis-status').textContent=data.message;}
      if(data.operation==='restore'){if(restoringRecovery){restoringRecovery=null;importRecovery=null;$('file-name').textContent='無法還原上一份 Trace';$('file-subtitle').textContent='可重新選擇原始檔案';}else{try{localStorage.removeItem('trace-studio-session');}catch{}loadDemo();}}
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
  $('info-content').innerHTML=`<div class="info-panel"><h3>來源與儲存</h3>${infoLine('檔案',i.source.name)}${infoLine('原始大小',bytes(i.source.size))}${infoLine('索引＋事件快取',bytes(i.diskBytes+(i.relations?.bytes||0)))}${infoLine('關聯索引',number(i.relations?.count||0))}${infoLine('完整事件數',number(i.count))}<p>原始事件在本機磁碟保留。畫面會依解析度聚合密集事件；放大可繼續展開，點選可讀取原始 JSON。未經過網路上傳。</p></div><div class="info-panel"><h3>事件類型</h3>${phases}</div><div class="info-panel"><h3>解析品質</h3>${infoLine('無法繪製／metadata 過大',number(i.skipped))}${infoLine('未配對 B / E',number(i.unmatched))}${infoLine('逆序時間戳',number(i.outOfOrder))}${infoLine('名稱摘要超過字典上限',number(i.nameLimit))}<p class="${i.unmatched||i.skipped||i.outOfOrder?'warning':''}">X 完整事件、B/E 同步區段、I/i/R 即時事件、C counter 可視化。其他 phase 保留為標記。非同步事件尚未重建區段。逆序資料仍可查詢，但可能增加磁碟讀取。</p></div><div class="info-panel"><h3>位址與關聯</h3><p>自動辨識 args 中的 address / addr / ptr / pointer 與十六進位字串，按精確位址連結。另支援明確 defines / uses 及 s/t/f flow ID。相同位址不代表因果關係、相同配置生命週期或範圍重疊；大於安全整數的數值 address 請用字串記錄。</p><p>每事件最多 32 個關聯鍵，每次顯示最多 64 筆關聯。完整原始 args 仍可讀取。</p></div><div class="info-panel full"><h3>檔案 Metadata</h3><div class="json-tree">${tree(i.metadata)}</div></div><div class="info-panel full"><h3>大檔設計與目前邊界</h3><p>分段讀取 → Worker 解析 → OPFS 磁碟索引 → 可見軌道查詢 → Canvas 繪製。未將整份 JSON 或全部事件載入主執行緒。需要桌面 Chrome / Edge、HTTPS 與足夠的瀏覽器儲存額度。3 GB 檔案的實際載入時間取決於事件數、args 大小、硬碟、可用空間與瀏覽器；請參考 GitHub 中公開的測試結果。這版尚未支援 Perfetto protobuf、SQL、stack sampling 重建與跨檔比較。</p></div>`;
}
function infoLine(a,b){return `<div class="info-line"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;}
function tree(obj,depth=0){
  if(obj===null||typeof obj!=='object')return `<span class="json-value">${esc(typeof obj==='string'?obj:JSON.stringify(obj))}</span>`;
  if(depth>12)return `<span class="json-value">結構深度超過 12 層，請展開下方原始 JSON。</span>`;
  const entries=Object.entries(obj);return entries.slice(0,200).map(([key,value])=>{
    if(value!==null&&typeof value==='object')return `<details open><summary><span class="json-key">${esc(key)}</span> <span class="json-value">${Array.isArray(value)?`Array(${value.length})`:`{ ${Object.keys(value).length} }`}</span></summary>${tree(value,depth+1)}</details>`;
    const address=/address|addr|ptr|pointer/i.test(key)||typeof value==='string'&&/^0x[0-9a-f]+$/i.test(value);
    const text=typeof value==='string'?value:JSON.stringify(value);return `<div class="json-leaf"><span class="json-key">${esc(key)}</span><span class="json-value ${address?'address':''}">${esc(text?.length>16000?text.slice(0,16000)+'…（完整內容見原始 JSON）':text)}</span></div>`;
  }).join('')+(entries.length>200?'<p>前 200 個欄位；完整資料請查看原始 JSON。</p>':'');
}
function setView(view){state.view=view;document.body.classList.toggle('timeline-workspace',view==='timeline');document.querySelectorAll('.view').forEach(e=>e.classList.toggle('active',e.id===`${view}-view`));document.querySelectorAll('.nav').forEach(e=>e.classList.toggle('active',e.dataset.view===view));$('breadcrumb').textContent=({timeline:'時間軸',events:'事件搜尋',insights:'Trace 分析',info:'Trace 資訊'})[view];if(view==='timeline'){measure();requestQuery();}if(view==='events')$('search-input').focus();}
function updateLayout(){
  const scroll=$('tracks-scroll'),oldTop=scroll.scrollTop,anchor=state.layout.find(r=>r.y+r.h>oldTop),offset=anchor?oldTop-anchor.y:0;
  const result=makeTrackLayout(state.groups,{collapsed:state.collapsed,filter:state.filter,pins:state.pins,expanded:state.expanded,density:state.density,lanes:state.lanes});state.layout=result.rows;
  const included=new Set(result.rows.flatMap(r=>r.type==='group'?r.trackIds:[r.track.id]));state.tracks=(state.info?.tracks||[]).filter(t=>included.has(t.id));
  $('tracks-space').style.height=`${Math.max(64,result.height)}px`;$('track-labels').style.height=`${result.height}px`;
  const next=anchor&&state.layout.find(r=>r.id===anchor.id);if(next)scroll.scrollTop=next.y+offset;
  $('track-visible').textContent=`${state.layout.filter(r=>r.type==='track').length} / ${state.tracks.length} 軌道`;
  measure();renderLabels();requestQuery();
}
function measure(){if(state.view!=='timeline')return;labelWidth=parseInt(getComputedStyle(document.documentElement).getPropertyValue('--label-width'))||250;const rect=$('tracks-scroll').getBoundingClientRect();plotWidth=Math.max(80,rect.width-labelWidth);plotHeight=rect.height;paint();drawOverview();}
function visibleLayout(){const top=$('tracks-scroll').scrollTop;return state.layout.filter(r=>r.y+r.h>=top&&r.y<=top+plotHeight);}
function renderLabels(){
  $('track-labels').innerHTML=visibleLayout().map(row=>{
    if(row.type==='group')return `<div class="track-label group-label ${row.group.kind}" style="top:${row.y}px;height:${row.h}px;padding-left:${8+row.depth*12}px"><button class="group-toggle" data-group="${esc(row.group.id)}" aria-expanded="${!row.collapsed}" title="${esc(row.group.label)}${row.group.pid===null?'':` · PID ${esc(row.group.pid)}`} · ${row.trackIds.length} 條軌道"><span>${row.collapsed?'▸':'▾'}</span><b>${esc(row.group.label)}</b><small>${row.trackIds.length}</small></button></div>`;
    const {track:t,y,h}=row;return `<div class="track-label" style="top:${y}px;height:${h}px;padding-left:${8+row.depth*12}px" data-track="${t.id}" title="${esc(t.name)} · PID ${esc(t.pid)} · TID ${esc(t.tid)} · ${number(t.count)} events；雙擊展開高度"><div class="track-label-top"><i class="track-color" style="background:${palette[t.id%palette.length]}"></i><span class="track-title">${esc(row.displayName)}</span><button class="pin ${state.pins.has(t.id)?'pinned':''}" data-pin="${t.id}" title="${state.pins.has(t.id)?'取消釘選':'釘選軌道'}" aria-label="釘選 ${esc(t.name)}">⌖</button></div><div class="track-meta"><span style="line-height:2">${number(t.count)} ${t.kind==='counter'?'samples':'events'}</span></div></div>`;
  }).join('');
}
function requestQuery(){paint();if(!state.info||state.view!=='timeline'||importing)return;if(queryBusy){queryDirty=true;return;}if(queryTimer)return;queryTimer=setTimeout(()=>{queryTimer=null;if(!state.info||importing)return;state.query++;queryBusy=true;const visible=visibleLayout();send('query',{requestId:state.query,start:state.start,end:state.end,trackIds:visible.filter(r=>r.type==='track').map(r=>r.track.id),groups:visible.filter(r=>r.type==='group'&&r.collapsed).map(r=>({id:r.id,trackIds:r.trackIds})),width:Math.ceil(plotWidth)});},25);}
function setRange(start,end){if(!state.info)return;const total=state.info.end-state.info.start,span=Math.max(.1,Math.min(total,end-start));if(start<state.info.start)start=state.info.start;if(start+span>state.info.end)start=state.info.end-span;state.start=start;state.end=start+span;requestQuery();drawOverview();}
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
  if(!state.info)return;const step=tickStep(),origin=state.info.start;
  for(let t=Math.ceil((state.start-origin)/step)*step+origin;t<=state.end;t+=step){const x=Math.round(xTime(t))+.5;ctx.strokeStyle=dark?'#2e3d31':'#ebeee7';ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,plotHeight);ctx.stroke();ruler.fillStyle=dark?'#b8c8ac':'#697b60';ruler.font='12px Consolas,monospace';ruler.fillText(formatTime(t-origin,true),x+5,Math.round(rulerHeight*.7));}
  for(const row of visibleLayout()){
    const y=row.y-scroll;ctx.strokeStyle=dark?'#344239':'#e7ece3';ctx.beginPath();ctx.moveTo(0,y+row.h-.5);ctx.lineTo(plotWidth,y+row.h-.5);ctx.stroke();
    if(row.type==='group'){
      ctx.fillStyle=dark?'#34423966':'#e7ede480';ctx.fillRect(0,y,plotWidth,row.h-1);
      if(row.collapsed){const bins=state.groupRows.get(row.id)||[],max=Math.max(1,...bins),width=plotWidth/Math.max(1,bins.length);
        for(let i=0;i<bins.length;i++)if(bins[i]){ctx.fillStyle=dark?`rgba(155,191,135,${.25+.65*Math.sqrt(bins[i]/max)})`:`rgba(99,143,78,${.18+.62*Math.sqrt(bins[i]/max)})`;ctx.fillRect(i*width,y+8,Math.max(1,width),row.h-16);}
        hitboxes.push({x:0,y,w:plotWidth,h:row.h,groupId:row.id,label:row.group.label,count:row.trackIds.length});
      }continue;
    }
    const rows=state.rows.get(row.track.id)||[];
    if(row.track.kind==='counter'){
      let min=Infinity,max=-Infinity;for(const r of rows){min=Math.min(min,r.value);max=Math.max(max,r.value);}const range=Math.max(1,max-min);
      if(rows.length){ctx.beginPath();rows.forEach((r,i)=>{const x=xTime(r.ts),py=y+row.h-13-(r.value-min)/range*(row.h-34);if(i===0)ctx.moveTo(x,py);else ctx.lineTo(x,py);hitboxes.push({x:x-4,y:py-7,w:8,h:14,record:r});});ctx.strokeStyle=eventColor({label:row.track.name},true).fill;ctx.lineWidth=1.3;ctx.stroke();ctx.lineWidth=1;ctx.lineTo(xTime(rows.at(-1).ts),y+row.h-10);ctx.lineTo(xTime(rows[0].ts),y+row.h-10);ctx.closePath();ctx.fillStyle=eventColor({label:row.track.name},dark).fill+'28';ctx.fill();ctx.fillStyle=dark?'#b8c9ab':'#697b60';ctx.font='12px Consolas,monospace';ctx.fillText(max.toFixed(1),8,y+17);}
      continue;
    }
    const maxLane=state.expanded.has(row.track.id)?8:4,laneHeight=state.density==='compact'?17:state.expanded.has(row.track.id)?22:19;
    for(const r of rows){const lane=Math.min(maxLane-1,r.lane||0),x=Math.max(-2,xTime(r.ts)),right=Math.min(plotWidth+2,xTime(r.ts+Math.max(0,r.dur))),w=Math.max(2,right-x-.8),py=y+(state.density==='compact'?7:9)+lane*(laneHeight+1);if(x>plotWidth||right<0)continue;
      const selected=state.selected?.offset===r.offset;
      ctx.fillStyle=(extensionHost.eventColor(r,{dark})||eventColor(r,dark)).fill;
      if(r.kind===1||r.kind===3){ctx.beginPath();ctx.moveTo(x,py+1);ctx.lineTo(x+4,py+laneHeight/2);ctx.lineTo(x,py+laneHeight-1);ctx.lineTo(x-4,py+laneHeight/2);ctx.closePath();ctx.fill();}
      else {ctx.beginPath();ctx.roundRect(x,py,w,laneHeight-1,1.5);ctx.fill();}
      if(selected){ctx.strokeStyle=dark?'#e4efb6':'#476f39';ctx.lineWidth=1.8;ctx.strokeRect(x-.5,py-.5,Math.max(3,w+1),laneHeight);ctx.lineWidth=1;}
      if(w>58&&r.kind===0){ctx.save();ctx.beginPath();ctx.rect(x+3,py,w-6,laneHeight);ctx.clip();ctx.font=`${state.expanded.has(row.track.id)?13:12}px Consolas,monospace`;ctx.fillStyle=dark?'#eef3df':'#2e4527';ctx.fillText(r.label+(r.n>1?` ×${r.n}`:''),x+4,py+laneHeight-5);ctx.restore();}
      hitboxes.push({x,y:py,w:Math.max(5,w),h:laneHeight,record:r});
    }
  }
  if(state.showLinks&&state.selected&&state.links.length){const selectedRow=state.layout.find(r=>r.track?.id===state.selected.trackId);if(selectedRow){const sx=xTime(state.selected.ts),sy=selectedRow.y-scroll+17;ctx.save();ctx.strokeStyle=dark?'#ead291':'#b49b58';ctx.lineWidth=1.3;ctx.setLineDash([4,3]);for(const link of state.links.slice(0,16)){const row=state.layout.find(r=>r.track?.id===link.record.trackId)||state.layout.find(r=>r.type==='group'&&r.collapsed&&r.trackIds.includes(link.record.trackId));if(!row)continue;const x=xTime(link.record.ts),y=row.y-scroll+17;if(Math.max(sx,x)<0||Math.min(sx,x)>plotWidth)continue;ctx.beginPath();ctx.moveTo(sx,sy);ctx.bezierCurveTo(sx+(x-sx)/2,sy,sx+(x-sx)/2,y,x,y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=dark?'#ead291':'#b49b58';ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();ctx.setLineDash([4,3]);}ctx.restore();}}
  if(state.area){const x1=xTime(state.area.start),x2=xTime(state.area.end);ctx.fillStyle='#8fb58c26';ctx.fillRect(x1,0,x2-x1,plotHeight);ctx.strokeStyle='#799d64';ctx.setLineDash([3,3]);for(const x of [x1,x2]){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,plotHeight);ctx.stroke();}ctx.setLineDash([]);}
  $('window-time').textContent=`${formatTime(state.start-origin,true)} — ${formatTime(state.end-origin,true)}`;
}
function drawOverview(){if(!state.info||state.view!=='timeline')return;const wrap=$('overview-wrap'),w=wrap.clientWidth,h=wrap.clientHeight;if(!w||!h)return;const ctx=canvasSetup($('overview'),w,h),bins=state.info.overview,max=Math.max(...bins,1),dark=document.body.classList.contains('dark');const bw=w/bins.length;
  bins.forEach((n,i)=>{const height=2+Math.pow(n/max,.55)*(h-4);ctx.fillStyle=dark?'#78976b':'#c0d0ad';ctx.fillRect(i*bw,h-height,Math.max(1,bw-1),height);ctx.fillStyle=dark?'#aec29a':'#95af7e';ctx.fillRect(i*bw,h-height,Math.max(1,bw-1),1);});const total=state.info.end-state.info.start;$('overview-window').style.left=`${(state.start-state.info.start)/total*100}%`;$('overview-window').style.width=`${(state.end-state.start)/total*100}%`;}
function selectRecord(r,ensureVisible=false){if(!state.info)return;state.selected=r;state.area=null;state.detail=null;state.links=[];state.detailId++;$('selection-heading').textContent=r.label||'事件詳情';$('details-content').innerHTML='<div class="selection-empty">讀取原始事件與位址關聯…</div>';$('details').hidden=false;send('detail',{requestId:state.detailId,record:r});if(ensureVisible){const d=Math.max(100,r.dur);if(r.ts<state.start||r.ts+r.dur>state.end)setRange(r.ts-d*.3,r.ts+d*1.4);scrollToTrack(r.trackId);}paint();}
function clearSelection(){state.selected=null;state.detail=null;state.links=[];state.area=null;$('selection-heading').textContent='目前選取';$('selection-badge').textContent='EVENT DETAILS';$('details-content').innerHTML='<div class="selection-empty">↖ 點選事件查看 args、位址關聯與原始 JSON。</div>';paint();}
function renderDetail(){
  const d=state.detail;if(!d||!state.selected)return;const e=d.event,r=state.selected,t=state.info.tracks[r.trackId],name=String(e.name??'').trim()?e.name:r.label||'未命名事件';$('selection-heading').textContent=name;$('selection-badge').textContent=r.n>1?`聚合 ${r.n} 筆 · 顯示代表事件`:'EVENT DETAILS';
  const extras=Object.fromEntries(Object.entries(e).filter(([key])=>!['name','ph','pid','tid','ts','dur','cat','args'].includes(key)));
  const links=d.links,linkType={address:'位址',symbol:'符號',flow:'Flow'};
  const linkHTML=links?.keys.length?`<section class="relation-section"><div class="relation-top"><b>⌁ 位址與事件關聯 <small>${links.capped?'前 64 筆 / ':''}${number(links.total)} 筆候選</small></b><button class="text-button" id="show-relations">${state.showLinks?'隱藏連線':'顯示連線'}</button></div><div class="relation-keys">${links.keys.map(k=>`<span class="relation-key">${linkType[k.type]} ${esc(k.key)} <span style="opacity:.6">${esc(k.path)}</span></span>`).join('')}</div><div class="relation-list">${links.matches.map((m,i)=>`<button class="relation-item" data-relation="${i}"><span>${esc(m.record.label)}<small>${m.relation.type==='address'?'相同位址':`${esc(m.relation.role)} → ${esc(m.otherRole)}`} · TID ${esc(state.info.tracks[m.record.trackId]?.tid)}</small></span><span class="relation-time">${formatTime(m.record.ts-state.info.start,true)} ↗</span></button>`).join('')||'<span style="font-size:14px;color:var(--muted)">此 Trace 沒有其他具有相同鍵的事件。</span>'}</div><p style="font-size:12px;color:var(--muted);margin-bottom:0">相同位址是比對線索，未證明因果或同一記憶體生命週期。連線最多繪製 16 筆。</p></section>`:'<section class="relation-section"><span style="font-size:14px;color:var(--muted)">此事件未找到可辨識的 address / ptr、defines / uses 或標準 flow ID。</span></section>';
  const custom=extensionHost.eventFields(e,{record:r,track:t}),extensionErrors=[...(extensionHost.startupErrors||[]),...custom.errors];
  const summary=[...eventSummary(e),...custom.fields],summaryHTML=summary.length?`<table class="event-fields"><caption>Trace 欄位摘要</caption><tbody>${summary.map(field=>`<tr title="${esc(field.path)}"><th scope="row">${esc(field.label)}</th><td>${esc(field.value)}</td></tr>`).join('')}</tbody></table>`:'';
  $('details-content').innerHTML=`<div class="event-summary"><h3>${esc(name)}</h3><span class="category-badge">${esc(e.cat||'uncategorized')} · ph=${esc(e.ph||'?')}</span><dl><dt>持續時間</dt><dd>${formatTime(r.dur||0)}</dd><dt>相對起點</dt><dd>${formatTime(r.ts-state.info.start)}</dd><dt>原始時間戳</dt><dd>${esc(e.ts)} µs</dd><dt>Process</dt><dd>${esc(state.info.processes[e.pid]||e.pid)}</dd><dt>軌道</dt><dd>${esc(t?trackName(t):e.tid)} · ${esc(e.tid)}</dd></dl></div><div>${summaryHTML}${extensionErrors.map(error=>`<p class="warning">${esc(error.title)}：${esc(error.message)}</p>`).join('')}<details class="arguments-section" open><summary>原始 Arguments · ${Object.keys(e.args||{}).length} 欄位</summary><div class="json-tree">${Object.keys(e.args||{}).length?tree(e.args):'<span class="json-key">此事件沒有 args。</span>'}${Object.keys(extras).length?`<details open><summary>其他原始欄位</summary>${tree(extras)}</details>`:''}${d.endEvent?`<details open><summary>配對的 E 事件</summary>${tree(d.endEvent)}</details>`:''}</div></details><details class="raw-details" open><summary>完整原始 JSON</summary><pre>${esc(d.rawText)}</pre></details></div>${linkHTML}`;
}
function showArea(start,end,trackIds){state.selected=null;state.detail=null;state.links=[];state.area={start:Math.min(start,end),end:Math.max(start,end),trackIds};$('details').hidden=false;$('selection-heading').textContent='時間範圍';$('selection-badge').textContent='AREA SELECTION';$('details-content').innerHTML=`<div class="event-summary"><h3>${formatTime(state.area.end-state.area.start)}</h3><span class="category-badge">${trackIds.length} 條軌道</span><dl><dt>起點</dt><dd>${formatTime(state.area.start-state.info.start)}</dd><dt>終點</dt><dd>${formatTime(state.area.end-state.info.start)}</dd></dl></div><div><div class="args-header"><b>範圍選取</b></div><p style="font-size:14px;color:var(--muted);line-height:2">按 F 聚焦這段時間。拖曳兩側邊界可以調整範圍。範圍時間是牆鐘時間，不等同於 CPU 耗時。</p><button class="soft-button" id="area-focus">⤢ 聚焦範圍 <kbd>F</kbd></button></div>`;paint();}
function renderEventRows(element,rows,note,search){
  element.innerHTML=`<div class="results-note">${esc(note)}</div>`+(rows.length?rows.map((r,i)=>`<button class="event-row" data-result="${i}" data-source="${search?'search':'top'}"><span class="rank">${String(i+1).padStart(2,'0')}</span><span><b>${esc(r.label||state.info?.names?.[r.name]||'')}</b><small>${esc(state.info?.tracks[r.trackId]?.name||'')} · PID ${esc(state.info?.tracks[r.trackId]?.pid)}</small></span><span class="time">${formatTime(r.dur,true)}${!search?`<div class="duration-bar" style="width:${Math.max(2,r.dur/rows[0].dur*100)}%"></div>`:''}</span><span class="time" style="color:var(--muted)">${formatTime(r.ts-state.info.start,true)} ↗</span></button>`).join(''):'<p class="empty-state">沒有符合的事件。試試不同的關鍵字。</p>');
}
function navigateRecord(r){setView('timeline');if(state.filter){state.filter='';$('track-filter').value='';updateLayout();}selectRecord(r,true);focusSelection();}
function search(){const term=$('search-input').value.trim();if(!state.info||!term)return;state.searchId++;$('search-results').innerHTML='<p class="empty-state">正在背景搜尋磁碟索引…</p>';send('search',{requestId:state.searchId,term});}
function setAnalysisBusy(busy){state.analysisBusy=busy;$('run-analysis').disabled=busy||!state.info;$('cancel-analysis').hidden=!busy;$('export-analysis').disabled=busy||!state.analysis;}
function runAnalysis(){
  if(!state.info||state.analysisBusy)return;const windowed=$('analysis-scope').value==='window',thresholdUs=Number($('analysis-threshold').value)*1000;
  if(!Number.isFinite(thresholdUs)||thresholdUs<0){toast('請輸入有效的長事件門檻。');return;}
  const group=allGroups(state.groups).find(g=>g.id===$('analysis-group').value);let ids=(windowed?state.tracks:state.info.tracks).filter(t=>t.count>0).map(t=>t.id);
  if(group){const allowed=new Set(group.tracks.map(t=>t.id));ids=ids.filter(id=>allowed.has(id));}
  state.analysisId++;state.analysis=null;$('analysis-results').innerHTML='';setAnalysisBusy(true);$('analysis-status').textContent='正在背景掃描索引，可切回時間軸繼續操作。';
  send('analysis',{requestId:state.analysisId,start:windowed?state.start:state.info.start,end:windowed?state.end:state.info.end,trackIds:ids,thresholdUs});
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
    extensions.map(extension=>`<section class="analysis-section"><h3>${esc(extension.title)}</h3>${extension.status==='error'?`<p class="warning">擴充失敗：${esc(extension.message)}</p>`:`<p class="analysis-note">${esc(extension.summary)}</p><table class="event-fields"><tbody>${extension.rows.map(row=>`<tr><th>${esc(row.label)}</th><td>${esc(row.value)}</td></tr>`).join('')}</tbody></table>`}</section>`).join('');
}
$('analysis-form').onsubmit=e=>{e.preventDefault();runAnalysis();};
$('cancel-analysis').onclick=()=>{send('cancelAnalysis');$('analysis-status').textContent='正在取消分析…';};
$('analysis-results').onclick=e=>{const record=e.target.closest('[data-analysis-record]'),name=e.target.closest('[data-analysis-name]');if(record){const r=state.analysis?.longest[Number(record.dataset.analysisRecord)]?.record;if(r)navigateRecord(r);}else if(name){const label=state.analysis?.byName[Number(name.dataset.analysisName)]?.label;if(label){setView('events');$('search-input').value=label;search();}}};
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
  if(hit){$('tooltip').innerHTML=hit.groupId?`${esc(hit.label)}<small>${hit.count} 條軌道的摘要概覽；點選展開，非精確事件數或使用率。</small>`:`${esc(hit.record.label)}<small>${formatTime(hit.record.dur||0)}${hit.record.kind===2?` · value ${hit.record.value.toFixed(2)}`:''}${hit.record.n>1?` · 聚合 ${hit.record.n} 筆，放大可展開`:''}</small>`;$('tooltip').hidden=false;$('tooltip').style.left=`${Math.max(8,Math.min(innerWidth-350,e.clientX+14))}px`;$('tooltip').style.top=`${Math.min(innerHeight-80,e.clientY+15)}px`;}else $('tooltip').hidden=true;
});
$('timeline').addEventListener('pointerup',e=>{if(!pointer)return;const p=localPoint(e);if(!pointer.moved){const hit=hitboxes.findLast(h=>p.x>=h.x&&p.x<=h.x+h.w&&p.y>=h.y&&p.y<=h.y+h.h);if(hit?.groupId)toggleGroup(hit.groupId);else if(hit)selectRecord(hit.record);else clearSelection();}pointer=null;});
$('timeline').addEventListener('pointercancel',()=>pointer=null);$('timeline').addEventListener('pointerleave',()=>$('tooltip').hidden=true);
$('timeline').addEventListener('dblclick',()=>focusSelection());
$('tracks-scroll').addEventListener('wheel',e=>{if(!state.info)return;if(e.ctrlKey||e.metaKey){e.preventDefault();zoom(1-wheelZoomRatio(e.deltaY),Math.max(0,Math.min(1,(e.clientX-$('timeline').getBoundingClientRect().left)/plotWidth)));}else if(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)){e.preventDefault();pan((e.deltaX||e.deltaY)/plotWidth);}},{passive:false});
$('tracks-scroll').addEventListener('scroll',()=>{renderLabels();requestQuery();},{passive:true});
$('overview-wrap').addEventListener('pointerdown',e=>{if(!state.info)return;overviewPointer={x:e.clientX,start:state.start,span:state.end-state.start};e.currentTarget.setPointerCapture(e.pointerId);const r=e.currentTarget.getBoundingClientRect(),t=state.info.start+(e.clientX-r.left)/r.width*(state.info.end-state.info.start);setRange(t-overviewPointer.span/2,t+overviewPointer.span/2);overviewPointer.start=state.start;});
$('overview-wrap').addEventListener('pointermove',e=>{if(!overviewPointer)return;const delta=(e.clientX-overviewPointer.x)/e.currentTarget.clientWidth*(state.info.end-state.info.start);setRange(overviewPointer.start+delta,overviewPointer.start+delta+overviewPointer.span);});
for(const evt of ['pointerup','pointercancel'])$('overview-wrap').addEventListener(evt,()=>overviewPointer=null);
function toggleGroup(id){if(state.collapsed.has(id))state.collapsed.delete(id);else state.collapsed.add(id);updateLayout();}
$('track-labels').addEventListener('click',e=>{const group=e.target.closest('[data-group]');if(group){toggleGroup(group.dataset.group);return;}const pin=e.target.closest('[data-pin]');if(pin){const id=Number(pin.dataset.pin);if(state.pins.has(id))state.pins.delete(id);else state.pins.add(id);updateLayout();$('tracks-scroll').scrollTop=0;}});
$('track-labels').addEventListener('dblclick',e=>{const label=e.target.closest('[data-track]');if(label){const id=Number(label.dataset.track);if(state.expanded.has(id))state.expanded.delete(id);else state.expanded.add(id);updateLayout();}});
$('track-filter').addEventListener('input',e=>{state.filter=e.target.value;updateLayout();});$('reset-filter').onclick=()=>{$('track-filter').value='';state.filter='';updateLayout();};
document.querySelectorAll('.nav').forEach(e=>e.onclick=()=>{setView(e.dataset.view);if(innerWidth<=900)applySidebar(true);});
$('open').onclick=()=>$('file').click();$('file').onchange=e=>{loadFile(e.target.files[0]);e.target.value='';};$('demo').onclick=loadDemo;
$('zoom-in').onclick=()=>zoom(.65);$('zoom-out').onclick=()=>zoom(1/.65);$('fit').onclick=fitAll;$('focus-selection').onclick=focusSelection;
$('toggle-details').onclick=()=>$('details').hidden=!$('details').hidden;
$('close-details').onclick=()=>$('details').hidden=true;
let drawerDrag=null;
function resizeDrawer(height){$('timeline-view').style.setProperty('--drawer-height',`${Math.max(100,Math.min(innerHeight*.6,height))}px`);}
$('details-resize').addEventListener('pointerdown',e=>{drawerDrag={y:e.clientY,height:$('details').getBoundingClientRect().height};e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault();});
$('details-resize').addEventListener('pointermove',e=>{if(drawerDrag)resizeDrawer(drawerDrag.height+drawerDrag.y-e.clientY);});
for(const event of ['pointerup','pointercancel'])$('details-resize').addEventListener(event,()=>drawerDrag=null);
$('details-resize').addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();e.stopPropagation();resizeDrawer($('details').getBoundingClientRect().height+(e.key==='ArrowUp'?20:-20));}});
$('expand-groups').onclick=()=>{state.collapsed.clear();updateLayout();};
$('collapse-groups').onclick=()=>{state.collapsed=new Set(allGroups(state.groups).map(group=>group.id));updateLayout();$('tracks-scroll').scrollTop=0;};
function applyDensity(){document.body.classList.toggle('density-compact',state.density==='compact');$('density-toggle').textContent=state.density==='compact'?'緊湊':'舒適';$('density-toggle').setAttribute('aria-pressed',String(state.density==='compact'));updateLayout();}
$('density-toggle').onclick=()=>{state.density=state.density==='compact'?'comfortable':'compact';try{localStorage.setItem('trace-studio-density',state.density);}catch{}applyDensity();};
function applySidebar(collapsed){document.body.classList.toggle('sidebar-collapsed',collapsed);$('toggle-sidebar').setAttribute('aria-expanded',String(!collapsed));$('toggle-sidebar').setAttribute('aria-label',collapsed?'展開側欄':'收合側欄');$('toggle-sidebar').title=collapsed?'展開側欄':'收合側欄';}
$('toggle-sidebar').onclick=()=>{const collapsed=!document.body.classList.contains('sidebar-collapsed');applySidebar(collapsed);try{localStorage.setItem('trace-studio-sidebar',collapsed?'collapsed':'expanded');}catch{}};
$('close-sidebar').onclick=()=>{applySidebar(true);try{localStorage.setItem('trace-studio-sidebar','collapsed');}catch{}};
$('copy').onclick=async()=>{if(!state.detail){toast('請先選取事件。');return;}try{await navigator.clipboard.writeText(state.detail.rawText);toast('已複製原始事件 JSON。');}catch{toast('瀏覽器未允許剪貼簿存取，可展開原始 JSON 手動複製。');}};
$('details-content').addEventListener('click',e=>{const relation=e.target.closest('[data-relation]');if(relation){const r=state.links[Number(relation.dataset.relation)]?.record;if(r)navigateRecord(r);}if(e.target.closest('#show-relations')){state.showLinks=!state.showLinks;renderDetail();paint();}if(e.target.closest('#area-focus'))focusSelection();});
for(const id of ['search-results','insights-list'])$(id).addEventListener('click',e=>{const button=e.target.closest('[data-result]');if(button){const r=(button.dataset.source==='search'?searchResults:state.info.top)[Number(button.dataset.result)];navigateRecord(r);}});
$('search-form').onsubmit=e=>{e.preventDefault();search();};
function openHelp(){if(!$('help').open)$('help').showModal();}
$('shortcuts').onclick=openHelp;$('help-link').onclick=openHelp;
document.querySelectorAll('[data-close]').forEach(e=>e.onclick=()=>$(e.dataset.close).close());
$('storage').onclick=async()=>{const q=await navigator.storage.estimate().catch(()=>({}));$('storage-usage').textContent=q.usage!==undefined?`本站已用 ${bytes(q.usage)} / 額度 ${bytes(q.quota||0)}`:'無法讀取儲存額度。';$('cache-dialog').showModal();};
$('clear-cache').onclick=()=>{startWorker();send('clear');};
function cancelImport(){startWorker();finishLoading();if(recoverImport('已取消開檔。'))return;toast('已取消。未完成的快取可從左側「清除 Trace 快取」移除。');let last;try{last=localStorage.getItem('trace-studio-session');}catch{}if(last){beginLoading('正在還原上一份 Trace',false);send('restore',{id:last});}else loadDemo();}
$('cancel').onclick=cancelImport;
$('loading').addEventListener('cancel',e=>{e.preventDefault();cancelImport();});
$('theme').onclick=()=>{document.body.classList.toggle('dark');try{localStorage.setItem('trace-studio-theme',document.body.classList.contains('dark')?'dark':'light');}catch{}paint();drawOverview();};
const commands=[['開啟 Trace 檔案','O',()=>$('file').click()],['載入多核心示範','',loadDemo],['展開全部核心與程序','',()=>$('expand-groups').click()],['收合全部核心與程序','',()=>$('collapse-groups').click()],['切換緊湊／舒適列高','',()=>$('density-toggle').click()],['顯示完整 Trace','',fitAll],['聚焦目前選取','F',focusSelection],['放大時間軸','W',()=>zoom(.65)],['縮小時間軸','S',()=>zoom(1/.65)],['搜尋事件名稱','/',()=>setView('events')],['尋找軌道','Ctrl P',()=>{setView('timeline');$('track-filter').focus();}],['切換詳情面板','Q',()=>$('details').hidden=!$('details').hidden],['切換深色模式','',()=>$('theme').click()],['Trace 資訊','',()=>setView('info')],['操作與快捷鍵','?',openHelp]];
function renderCommands(){const term=$('command-input').value.toLowerCase();filteredCommands=commands.filter(c=>c[0].toLowerCase().includes(term));commandIndex=Math.min(commandIndex,Math.max(0,filteredCommands.length-1));$('command-list').innerHTML=filteredCommands.map((c,i)=>`<button data-command="${i}" class="${i===commandIndex?'command-selected':''}"><span>${c[0]}</span><kbd>${c[1]||'↵'}</kbd></button>`).join('');}
function openCommands(){renderCommands();$('commands').showModal();$('command-input').focus();}
$('command-input').oninput=()=>{commandIndex=0;renderCommands();};$('command-input').onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();commandIndex=(commandIndex+(e.key==='ArrowDown'?1:-1)+filteredCommands.length)%Math.max(1,filteredCommands.length);renderCommands();}if(e.key==='Enter'){e.preventDefault();const command=filteredCommands[commandIndex];$('commands').close();command?.[2]();}};
$('command-list').onclick=e=>{const b=e.target.closest('[data-command]');if(b){$('commands').close();filteredCommands[Number(b.dataset.command)]?.[2]();}};
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){$('tooltip').hidden=true;if(!document.querySelector('dialog[open]')){clearSelection();document.activeElement?.blur();}return;}
  const editing=/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable;
  if(document.querySelector('dialog[open]'))return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='p'){e.preventDefault();if(e.shiftKey)openCommands();else{setView('timeline');$('track-filter').focus();}return;}
  if(editing||e.ctrlKey||e.metaKey||e.altKey)return;
  const key=e.key.toLowerCase();
  const handlers={f:focusSelection,q:()=>$('details').hidden=!$('details').hidden,r:()=>{if(state.selected)showArea(state.selected.ts,state.selected.ts+state.selected.dur,[state.selected.trackId]);},o:()=>$('file').click(),'/':()=>setView('events'),'?':openHelp,'.':()=>{if(state.selected)send('neighbor',{record:state.selected,direction:1});},',':()=>{if(state.selected)send('neighbor',{record:state.selected,direction:-1});},'>':openCommands};
  if(handlers[key]){e.preventDefault();handlers[key]();}
});
let dragDepth=0;document.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;$('dropzone').hidden=false;}});document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('dropzone').hidden=true;}});document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('dropzone').hidden=true;if(importing){toast('請先完成或取消目前的匯入。');return;}if(e.dataTransfer.files.length>1)toast('目前一次開啟一份 Trace，已選擇第一份。');loadFile(e.dataTransfer.files[0]);});
new PerfettoNavigation($('timeline'),{pan:px=>pan(px/plotWidth),zoom:(x,ratio)=>zoom(Math.max(.01,1-ratio),x===null?.5:Math.max(0,Math.min(1,x/plotWidth))),editable:e=>state.view!=='timeline'||!state.info||!!document.querySelector('dialog[open]')||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable});
new ResizeObserver(()=>{measure();renderLabels();requestQuery();}).observe($('tracks-scroll'));
try{if(localStorage.getItem('trace-studio-theme')==='dark')document.body.classList.add('dark');if(localStorage.getItem('trace-studio-density')==='comfortable')state.density='comfortable';applySidebar(localStorage.getItem('trace-studio-sidebar')!=='expanded');}catch{}applyDensity();
startWorker();const last=(()=>{try{return localStorage.getItem('trace-studio-session');}catch{return null;}})();if(last){beginLoading('從本機索引還原');send('restore',{id:last});}else loadDemo();
