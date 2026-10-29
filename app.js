import {PerfettoNavigation,wheelZoomRatio} from './navigation.js';
const $=id=>document.getElementById(id), esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={info:null,start:0,end:1,tracks:[],layout:[],rows:new Map(),pins:new Set(),expanded:new Set(),selected:null,detail:null,links:[],area:null,filter:'',view:'timeline',query:0,detailId:0,searchId:0,showLinks:true};
let worker,queryTimer,paintFrame,toastTimer,searchResults=[],commandIndex=0,filteredCommands=[],importing=false,queryBusy=false,queryDirty=false;
let labelWidth=224,plotWidth=700,plotHeight=330,hitboxes=[],pointer=null,overviewPointer=null;
const palette=['#a8c995','#aac4d9','#e3c489','#bcb2d2','#b4d7cd','#d9b7a8'];
const darkPalette=['#688957','#68869b','#a08b56','#81759c','#5c8b7e','#a17b67'];
function formatTime(us,short=false){const n=Math.abs(us);if(n>=1e6)return `${(us/1e6).toFixed(short?2:3)} s`;if(n>=1000)return `${(us/1000).toFixed(short?1:3)} ms`;return `${us.toFixed(n<1?2:1)} µs`;}
function bytes(n){return n>=1e9?`${(n/1e9).toFixed(2)} GB`:n>=1e6?`${(n/1e6).toFixed(1)} MB`:`${(n/1e3).toFixed(0)} KB`;}
function number(n){return n.toLocaleString('en-US');}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function send(type,data={}){worker.postMessage({type,...data});}
function startWorker(){worker?.terminate();queryBusy=false;queryDirty=false;clearTimeout(queryTimer);queryTimer=null;worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});worker.onmessage=handleMessage;worker.onerror=e=>{finishLoading();toast(`背景引擎錯誤：${e.message}`);};}
function finishLoading(){importing=false;if($('loading').open)$('loading').close();}
function beginLoading(title='正在讀取 Trace'){
  importing=true;state.info=null;state.rows.clear();state.selected=null;state.links=[];state.area=null;state.detail=null;
  $('loading-title').textContent=title;$('progress-bar').style.width='0%';$('progress-percent').textContent='0%';$('progress-bytes').textContent='準備磁碟索引…';$('progress-events').textContent='0';$('progress-rate').textContent='— MB/s';
  if(!$('loading').open)$('loading').showModal();
}
function loadFile(file){if(!file)return;if(!/\.(json|gz)$/i.test(file.name)){toast('目前支援 Chrome Trace JSON（.json / .json.gz），請先轉換其他格式。');return;}startWorker();beginLoading();send('import',{file});}
function loadDemo(){startWorker();beginLoading('正在準備示範 Trace');send('demo');}
function handleMessage({data}){
  switch(data.type){
    case 'progress':{
      const p=Math.min(99.9,data.bytes/Math.max(1,data.total)*100);$('progress-bar').style.width=`${p}%`;$('progress-percent').textContent=`${p.toFixed(1)}%`;
      $('progress-bytes').textContent=`${bytes(data.bytes)} / ${bytes(data.total)}`;$('progress-events').textContent=number(data.events);$('progress-rate').textContent=`${(data.bytes/1e6/Math.max(.01,data.elapsed)).toFixed(1)} MB/s`;break;
    }
    case 'ready':{
      state.info=data.info;state.start=data.info.start;state.end=data.info.end;state.selected=null;state.detail=null;state.links=[];state.pins.clear();state.expanded.clear();state.filter='';$('track-filter').value='';finishLoading();
      try{localStorage.setItem('trace-studio-session',data.info.id);}catch{}
      updateInfo(data.restored);setView('timeline');updateLayout();drawOverview();requestQuery();
      if(data.info.source.demo){const r=data.info.top.find(r=>r.dur>100000);if(r)selectRecord(r);}
      else toast(data.restored?'已從本機快取還原，不需重新解析。':`已完成索引：${number(data.info.count)} 筆事件，${data.info.importSeconds.toFixed(2)} 秒。`);
      break;
    }
    case 'query':queryBusy=false;if(data.requestId===state.query){state.rows=new Map(data.rows.map(r=>[r.id,r.rows]));$('render-info').textContent=`${data.ms.toFixed(1)} ms query · ${number(data.rows.reduce((n,r)=>n+r.rows.length,0))} 畫面節點`;paint();}if(queryDirty){queryDirty=false;requestQuery();}break;
    case 'detail':if(data.requestId===state.detailId){state.detail=data;state.links=data.links?.matches||[];renderDetail();paint();}break;
    case 'searchProgress':if(data.requestId===state.searchId)$('search-results').innerHTML=`<p class="empty-state">搜尋中… 已掃描 ${number(data.scanned)} 筆索引</p>`;break;
    case 'search':if(data.requestId===state.searchId){searchResults=data.results;renderEventRows($('search-results'),data.results,data.capped?'顯示前 100 筆符合結果。縮小關鍵字可找到更精確的事件。':`找到 ${number(data.results.length)} 筆事件。`,true);}break;
    case 'neighbor':if(data.record)selectRecord(data.record,true);else toast('已到達這條軌道的邊界。');break;
    case 'cleared':try{localStorage.removeItem('trace-studio-session');}catch{}$('cache-dialog').close();toast('Trace 快取已清除。');loadDemo();break;
    case 'error':{
      finishLoading();toast(data.message);
      if(data.operation==='restore'){try{localStorage.removeItem('trace-studio-session');}catch{}loadDemo();}
      else if(data.operation==='import'||data.operation==='demo'){state.info=null;state.rows.clear();$('file-name').textContent='無法開啟 Trace';$('file-subtitle').textContent='請選擇另一個 JSON 檔案';$('details-content').innerHTML=`<div class="selection-empty">${esc(data.message)}</div>`;paint();}
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
  renderEventRows($('insights-list'),i.top,'事件持續時間，非獨占 CPU 耗時。',false);
  const phases=Object.entries(i.phases).map(([ph,n])=>`<div class="info-line"><span>ph = ${esc(ph)}</span><span>${number(n)}</span></div>`).join('');
  $('info-content').innerHTML=`<div class="info-panel"><h3>來源與儲存</h3>${infoLine('檔案',i.source.name)}${infoLine('原始大小',bytes(i.source.size))}${infoLine('索引＋事件快取',bytes(i.diskBytes+(i.relations?.bytes||0)))}${infoLine('關聯索引',number(i.relations?.count||0))}${infoLine('完整事件數',number(i.count))}<p>原始事件在本機磁碟保留。畫面會依解析度聚合密集事件；放大可繼續展開，點選可讀取原始 JSON。未經過網路上傳。</p></div><div class="info-panel"><h3>事件類型</h3>${phases}</div><div class="info-panel"><h3>解析品質</h3>${infoLine('無法繪製／metadata 過大',number(i.skipped))}${infoLine('未配對 B / E',number(i.unmatched))}${infoLine('逆序時間戳',number(i.outOfOrder))}${infoLine('名稱摘要超過字典上限',number(i.nameLimit))}<p class="${i.unmatched||i.skipped||i.outOfOrder?'warning':''}">X 完整事件、B/E 同步區段、I/i/R 即時事件、C counter 可視化。其他 phase 保留為標記。非同步事件尚未重建區段。逆序資料仍可查詢，但可能增加磁碟讀取。</p></div><div class="info-panel"><h3>位址與關聯</h3><p>自動辨識 args 中的 address / addr / ptr / pointer 與十六進位字串，按精確位址連結。另支援明確 defines / uses 及 s/t/f flow ID。相同位址不代表因果關係、相同配置生命週期或範圍重疊；大於安全整數的數值 address 請用字串記錄。</p><p>每事件最多 32 個關聯鍵，每次顯示最多 64 筆關聯。完整原始 args 仍可讀取。</p></div><div class="info-panel full"><h3>檔案 Metadata</h3><div class="json-tree">${tree(i.metadata)}</div></div><div class="info-panel full"><h3>大檔設計與目前邊界</h3><p>分段讀取 → Worker 解析 → OPFS 磁碟索引 → 可見軌道查詢 → Canvas 繪製。未將整份 JSON 或全部事件載入主執行緒。需要桌面 Chrome / Edge、HTTPS 與足夠的瀏覽器儲存額度。3 GB 檔案的實際載入時間取決於事件數、args 大小、硬碟、可用空間與瀏覽器；請參考 GitHub 中公開的測試結果。這版尚未支援 Perfetto protobuf、SQL、stack sampling 重建與跨檔比較。</p></div>`;
}
function infoLine(a,b){return `<div class="info-line"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;}
function tree(obj,depth=0){
  if(obj===null||typeof obj!=='object')return `<span class="json-value">${esc(typeof obj==='string'?obj:JSON.stringify(obj))}</span>`;
  if(depth>12)return `<span class="json-value">結構深度超過 12 層，請展開下方原始 JSON。</span>`;
  const entries=Object.entries(obj);return entries.slice(0,200).map(([key,value])=>{
    if(value!==null&&typeof value==='object')return `<details ${depth<1?'open':''}><summary><span class="json-key">${esc(key)}</span> <span class="json-value">${Array.isArray(value)?`Array(${value.length})`:`{ ${Object.keys(value).length} }`}</span></summary>${tree(value,depth+1)}</details>`;
    const address=/address|addr|ptr|pointer/i.test(key)||typeof value==='string'&&/^0x[0-9a-f]+$/i.test(value);
    const text=typeof value==='string'?value:JSON.stringify(value);return `<div class="json-leaf"><span class="json-key">${esc(key)}</span><span class="json-value ${address?'address':''}">${esc(text?.length>16000?text.slice(0,16000)+'…（完整內容見原始 JSON）':text)}</span></div>`;
  }).join('')+(entries.length>200?'<p>前 200 個欄位；完整資料請查看原始 JSON。</p>':'');
}
function setView(view){state.view=view;document.querySelectorAll('.view').forEach(e=>e.classList.toggle('active',e.id===`${view}-view`));document.querySelectorAll('.nav').forEach(e=>e.classList.toggle('active',e.dataset.view===view));$('breadcrumb').textContent=({timeline:'時間軸',events:'事件搜尋',insights:'耗時分析',info:'Trace 資訊'})[view];if(view==='timeline'){measure();requestQuery();}if(view==='events')$('search-input').focus();}
function filteredTracks(){if(!state.info)return [];const words=state.filter.toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);return state.info.tracks.filter(t=>t.count>0&&(!words.length||words.some(w=>`${t.name} ${t.pid} ${t.tid} ${state.info.processes[t.pid]||''}`.toLowerCase().includes(w)))).sort((a,b)=>Number(state.pins.has(b.id))-Number(state.pins.has(a.id))||a.id-b.id);}
function updateLayout(){
  state.tracks=filteredTracks();let y=0;state.layout=state.tracks.map(track=>{const h=state.expanded.has(track.id)?154:track.kind==='counter'?72:68;const item={track,y,h};y+=h;return item;});
  $('tracks-space').style.height=`${Math.max(200,y)}px`;$('track-labels').style.height=`${y}px`;$('track-visible').textContent=`${state.tracks.length} 條軌道`;
  measure();renderLabels();requestQuery();
}
function measure(){if(state.view!=='timeline')return;labelWidth=parseInt(getComputedStyle(document.documentElement).getPropertyValue('--label-width'))||224;const rect=$('tracks-scroll').getBoundingClientRect();plotWidth=Math.max(80,rect.width-labelWidth);plotHeight=rect.height;paint();drawOverview();}
function visibleLayout(){const top=$('tracks-scroll').scrollTop;return state.layout.filter(r=>r.y+r.h>=top&&r.y<=top+plotHeight);}
function renderLabels(){
  $('track-labels').innerHTML=visibleLayout().map(({track:t,y,h})=>`<div class="track-label" style="top:${y}px;height:${h}px" data-track="${t.id}" title="${esc(t.name)}；雙擊展開高度"><div class="track-label-top"><i class="track-color" style="background:${palette[t.id%palette.length]}"></i><span class="track-title">${esc(t.name)}</span><button class="pin ${state.pins.has(t.id)?'pinned':''}" data-pin="${t.id}" title="${state.pins.has(t.id)?'取消釘選':'釘選軌道'}" aria-label="釘選 ${esc(t.name)}">⌖</button></div><div class="track-meta">PID ${esc(t.pid)} · TID ${esc(t.tid)}<br><span style="line-height:2">${number(t.count)} ${t.kind==='counter'?'samples':'events'}</span></div></div>`).join('');
}
function requestQuery(){paint();if(!state.info||state.view!=='timeline'||importing)return;if(queryBusy){queryDirty=true;return;}if(queryTimer)return;queryTimer=setTimeout(()=>{queryTimer=null;if(!state.info||importing)return;state.query++;queryBusy=true;send('query',{requestId:state.query,start:state.start,end:state.end,trackIds:visibleLayout().map(r=>r.track.id),width:Math.ceil(plotWidth)});},25);}
function setRange(start,end){if(!state.info)return;const total=state.info.end-state.info.start,span=Math.max(.1,Math.min(total,end-start));if(start<state.info.start)start=state.info.start;if(start+span>state.info.end)start=state.info.end-span;state.start=start;state.end=start+span;requestQuery();drawOverview();}
function zoom(factor,anchor=.5){const span=state.end-state.start,newSpan=span*factor,center=state.start+span*anchor;setRange(center-newSpan*anchor,center+newSpan*(1-anchor));}
function pan(fraction){const delta=(state.end-state.start)*fraction;setRange(state.start+delta,state.end+delta);}
function fitAll(){if(state.info)setRange(state.info.start,state.info.end);}
function focusSelection(){if(state.area){const d=Math.max(.1,state.area.end-state.area.start);setRange(state.area.start-d*.1,state.area.end+d*.1);}else if(state.selected){const r=state.selected,d=Math.max(10,r.dur||100);setRange(r.ts-d*.2,r.ts+d*1.2);scrollToTrack(r.trackId);}else fitAll();}
function scrollToTrack(id){const row=state.layout.find(r=>r.track.id===id);if(row){const scroll=$('tracks-scroll');if(row.y<scroll.scrollTop||row.y+row.h>scroll.scrollTop+plotHeight)scroll.scrollTop=Math.max(0,row.y-40);renderLabels();requestQuery();}}
function canvasSetup(canvas,width,height){const dpr=devicePixelRatio||1;if(canvas.width!==Math.floor(width*dpr)||canvas.height!==Math.floor(height*dpr)){canvas.width=Math.floor(width*dpr);canvas.height=Math.floor(height*dpr);}canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);return ctx;}
function tickStep(){const raw=(state.end-state.start)/6,mag=10**Math.floor(Math.log10(raw));return [1,2,5,10].find(x=>x*mag>=raw)*mag;}
function xTime(t){return (t-state.start)/(state.end-state.start)*plotWidth;}
function timeX(x){return state.start+x/plotWidth*(state.end-state.start);}
function paint(){if(paintFrame)return;paintFrame=requestAnimationFrame(()=>{paintFrame=0;drawTimeline();});}
function drawTimeline(){
  if(state.view!=='timeline')return;const canvas=$('timeline'),scroll=$('tracks-scroll').scrollTop;canvas.style.top=`${scroll}px`;
  const ctx=canvasSetup(canvas,plotWidth,plotHeight),ruler=canvasSetup($('ruler'),plotWidth,28),dark=document.body.classList.contains('dark');hitboxes=[];
  ctx.fillStyle=dark?'#1c2b22':'#fcfdfb';ctx.fillRect(0,0,plotWidth,plotHeight);
  if(!state.info)return;const step=tickStep(),origin=state.info.start;
  for(let t=Math.ceil((state.start-origin)/step)*step+origin;t<=state.end;t+=step){const x=Math.round(xTime(t))+.5;ctx.strokeStyle=dark?'#2e3d31':'#ebeee7';ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,plotHeight);ctx.stroke();ruler.fillStyle=dark?'#91a185':'#95a18c';ruler.font='8px Consolas,monospace';ruler.fillText(formatTime(t-origin,true),x+5,18);}
  for(const row of visibleLayout()){
    const y=row.y-scroll,rows=state.rows.get(row.track.id)||[];ctx.strokeStyle=dark?'#344239':'#e7ece3';ctx.beginPath();ctx.moveTo(0,y+row.h-.5);ctx.lineTo(plotWidth,y+row.h-.5);ctx.stroke();
    if(row.track.kind==='counter'){
      let min=Infinity,max=-Infinity;for(const r of rows){min=Math.min(min,r.value);max=Math.max(max,r.value);}const range=Math.max(1,max-min);
      if(rows.length){ctx.beginPath();rows.forEach((r,i)=>{const x=xTime(r.ts),py=y+row.h-13-(r.value-min)/range*(row.h-28);if(i===0)ctx.moveTo(x,py);else ctx.lineTo(x,py);hitboxes.push({x:x-4,y:py-7,w:8,h:14,record:r});});ctx.strokeStyle=dark?'#a2bd87':'#8daa75';ctx.lineWidth=1.3;ctx.stroke();ctx.lineWidth=1;ctx.lineTo(xTime(rows.at(-1).ts),y+row.h-10);ctx.lineTo(xTime(rows[0].ts),y+row.h-10);ctx.closePath();ctx.fillStyle=dark?'#8daa7520':'#b4c99b30';ctx.fill();ctx.fillStyle=dark?'#b8c9ab':'#91a27e';ctx.font='8px Consolas,monospace';ctx.fillText(max.toFixed(1),8,y+15);}
      continue;
    }
    const maxLane=state.expanded.has(row.track.id)?8:4,laneHeight=state.expanded.has(row.track.id)?16:12;
    for(const r of rows){const lane=Math.min(maxLane-1,r.lane||0),x=Math.max(-2,xTime(r.ts)),right=Math.min(plotWidth+2,xTime(r.ts+Math.max(0,r.dur))),w=Math.max(2,right-x-.8),py=y+9+lane*(laneHeight+1);if(x>plotWidth||right<0)continue;
      const selected=state.selected?.offset===r.offset;
      let color=r.color%palette.length;if(/script|function|v8|react|reconcile|performwork/i.test(r.label))color=1;else if(/layout|paint|raster|frame|commit|composite/i.test(r.label))color=0;else if(/request|resource|network/i.test(r.label))color=2;
      ctx.fillStyle=(dark?darkPalette:palette)[color];
      if(r.kind===1||r.kind===3){ctx.beginPath();ctx.moveTo(x,py+1);ctx.lineTo(x+4,py+laneHeight/2);ctx.lineTo(x,py+laneHeight-1);ctx.lineTo(x-4,py+laneHeight/2);ctx.closePath();ctx.fill();}
      else {ctx.beginPath();ctx.roundRect(x,py,w,laneHeight-1,1.5);ctx.fill();}
      if(selected){ctx.strokeStyle=dark?'#e4efb6':'#476f39';ctx.lineWidth=1.8;ctx.strokeRect(x-.5,py-.5,Math.max(3,w+1),laneHeight);ctx.lineWidth=1;}
      if(w>45&&r.kind===0){ctx.save();ctx.beginPath();ctx.rect(x+3,py,w-6,laneHeight);ctx.clip();ctx.font=`${Math.min(9,laneHeight-3)}px Consolas,monospace`;ctx.fillStyle=dark?'#eef3df':'#3b5032';ctx.fillText(r.label+(r.n>1?` ×${r.n}`:''),x+4,py+laneHeight-3);ctx.restore();}
      hitboxes.push({x,y:py,w:Math.max(5,w),h:laneHeight,record:r});
    }
  }
  if(state.showLinks&&state.selected&&state.links.length){const selectedRow=state.layout.find(r=>r.track.id===state.selected.trackId);if(selectedRow){const sx=xTime(state.selected.ts),sy=selectedRow.y-scroll+17;ctx.save();ctx.strokeStyle=dark?'#ead291':'#b49b58';ctx.lineWidth=1.3;ctx.setLineDash([4,3]);for(const link of state.links.slice(0,16)){const row=state.layout.find(r=>r.track.id===link.record.trackId);if(!row)continue;const x=xTime(link.record.ts),y=row.y-scroll+17;if(Math.max(sx,x)<0||Math.min(sx,x)>plotWidth)continue;ctx.beginPath();ctx.moveTo(sx,sy);ctx.bezierCurveTo(sx+(x-sx)/2,sy,sx+(x-sx)/2,y,x,y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=dark?'#ead291':'#b49b58';ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();ctx.setLineDash([4,3]);}ctx.restore();}}
  if(state.area){const x1=xTime(state.area.start),x2=xTime(state.area.end);ctx.fillStyle='#8fb58c26';ctx.fillRect(x1,0,x2-x1,plotHeight);ctx.strokeStyle='#799d64';ctx.setLineDash([3,3]);for(const x of [x1,x2]){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,plotHeight);ctx.stroke();}ctx.setLineDash([]);}
  $('window-time').textContent=`${formatTime(state.start-origin,true)} — ${formatTime(state.end-origin,true)}`;
}
function drawOverview(){if(!state.info||state.view!=='timeline')return;const wrap=$('overview-wrap'),w=wrap.clientWidth;if(!w)return;const ctx=canvasSetup($('overview'),w,43),bins=state.info.overview,max=Math.max(...bins,1),dark=document.body.classList.contains('dark');const bw=w/bins.length;
  bins.forEach((n,i)=>{const height=3+Math.pow(n/max,.55)*36;ctx.fillStyle=dark?'#78976b':'#c0d0ad';ctx.fillRect(i*bw,43-height,Math.max(1,bw-1),height);ctx.fillStyle=dark?'#aec29a':'#95af7e';ctx.fillRect(i*bw,43-height,Math.max(1,bw-1),1);});const total=state.info.end-state.info.start;$('overview-window').style.left=`${(state.start-state.info.start)/total*100}%`;$('overview-window').style.width=`${(state.end-state.start)/total*100}%`;}
function selectRecord(r,ensureVisible=false){if(!state.info)return;state.selected=r;state.area=null;state.detail=null;state.links=[];state.detailId++;$('selection-heading').textContent=r.label||'事件詳情';$('details-content').innerHTML='<div class="selection-empty">讀取原始事件與位址關聯…</div>';$('details').hidden=false;send('detail',{requestId:state.detailId,record:r});if(ensureVisible){const d=Math.max(100,r.dur);if(r.ts<state.start||r.ts+r.dur>state.end)setRange(r.ts-d*.3,r.ts+d*1.4);scrollToTrack(r.trackId);}paint();}
function clearSelection(){state.selected=null;state.detail=null;state.links=[];state.area=null;$('selection-heading').textContent='目前選取';$('selection-badge').textContent='EVENT DETAILS';$('details-content').innerHTML='<div class="selection-empty">↖ 點選事件查看 args、位址關聯與原始 JSON。</div>';paint();}
function renderDetail(){
  const d=state.detail;if(!d||!state.selected)return;const e=d.event,r=state.selected,t=state.info.tracks[r.trackId];$('selection-heading').textContent=e.name||'Unnamed event';$('selection-badge').textContent=r.n>1?`聚合 ${r.n} 筆 · 顯示代表事件`:'EVENT DETAILS';
  const extras=Object.fromEntries(Object.entries(e).filter(([key])=>!['name','ph','pid','tid','ts','dur','cat','args'].includes(key)));
  const links=d.links,linkType={address:'位址',symbol:'符號',flow:'Flow'};
  const linkHTML=links?.keys.length?`<section class="relation-section"><div class="relation-top"><b>⌁ 位址與事件關聯 <small>${links.capped?'前 64 筆 / ':''}${number(links.total)} 筆候選</small></b><button class="text-button" id="show-relations">${state.showLinks?'隱藏連線':'顯示連線'}</button></div><div class="relation-keys">${links.keys.map(k=>`<span class="relation-key">${linkType[k.type]} ${esc(k.key)} <span style="opacity:.6">${esc(k.path)}</span></span>`).join('')}</div><div class="relation-list">${links.matches.map((m,i)=>`<button class="relation-item" data-relation="${i}"><span>${esc(m.record.label)}<small>${m.relation.type==='address'?'相同位址':`${esc(m.relation.role)} → ${esc(m.otherRole)}`} · TID ${esc(state.info.tracks[m.record.trackId]?.tid)}</small></span><span class="relation-time">${formatTime(m.record.ts-state.info.start,true)} ↗</span></button>`).join('')||'<span style="font-size:10px;color:var(--muted)">此 Trace 沒有其他具有相同鍵的事件。</span>'}</div><p style="font-size:9px;color:var(--muted);margin-bottom:0">相同位址是比對線索，未證明因果或同一記憶體生命週期。連線最多繪製 16 筆。</p></section>`:'<section class="relation-section"><span style="font-size:10px;color:var(--muted)">此事件未找到可辨識的 address / ptr、defines / uses 或標準 flow ID。</span></section>';
  $('details-content').innerHTML=`<div class="event-summary"><h3>${esc(e.name||'Unnamed event')}</h3><span class="category-badge">${esc(e.cat||'uncategorized')} · ph=${esc(e.ph||'?')}</span><dl><dt>持續時間</dt><dd>${formatTime(r.dur||0)}</dd><dt>相對起點</dt><dd>${formatTime(r.ts-state.info.start)}</dd><dt>原始時間戳</dt><dd>${esc(e.ts)} µs</dd><dt>Process</dt><dd>${esc(state.info.processes[e.pid]||e.pid)}</dd><dt>Thread</dt><dd>${esc(t?.name||e.tid)} (${esc(e.tid)})</dd></dl></div><div><div class="args-header"><b>Arguments</b><span>${Object.keys(e.args||{}).length} FIELDS</span></div><div class="json-tree">${Object.keys(e.args||{}).length?tree(e.args):'<span class="json-key">此事件沒有 args。</span>'}${Object.keys(extras).length?`<details><summary>其他原始欄位</summary>${tree(extras)}</details>`:''}${d.endEvent?`<details><summary>配對的 E 事件</summary>${tree(d.endEvent)}</details>`:''}</div><details class="raw-details"><summary>查看完整原始 JSON</summary><pre>${esc(d.rawText)}</pre></details></div>${linkHTML}`;
}
function showArea(start,end,trackIds){state.selected=null;state.detail=null;state.links=[];state.area={start:Math.min(start,end),end:Math.max(start,end),trackIds};$('details').hidden=false;$('selection-heading').textContent='時間範圍';$('selection-badge').textContent='AREA SELECTION';$('details-content').innerHTML=`<div class="event-summary"><h3>${formatTime(state.area.end-state.area.start)}</h3><span class="category-badge">${trackIds.length} 條軌道</span><dl><dt>起點</dt><dd>${formatTime(state.area.start-state.info.start)}</dd><dt>終點</dt><dd>${formatTime(state.area.end-state.info.start)}</dd></dl></div><div><div class="args-header"><b>範圍選取</b></div><p style="font-size:11px;color:var(--muted);line-height:2">按 F 聚焦這段時間。拖曳兩側邊界可以調整範圍。範圍時間是牆鐘時間，不等同於 CPU 耗時。</p><button class="soft-button" id="area-focus">⤢ 聚焦範圍 <kbd>F</kbd></button></div>`;paint();}
function renderEventRows(element,rows,note,search){
  element.innerHTML=`<div class="results-note">${esc(note)}</div>`+(rows.length?rows.map((r,i)=>`<button class="event-row" data-result="${i}" data-source="${search?'search':'top'}"><span class="rank">${String(i+1).padStart(2,'0')}</span><span><b>${esc(r.label||state.info?.names?.[r.name]||'')}</b><small>${esc(state.info?.tracks[r.trackId]?.name||'')} · PID ${esc(state.info?.tracks[r.trackId]?.pid)}</small></span><span class="time">${formatTime(r.dur,true)}${!search?`<div class="duration-bar" style="width:${Math.max(2,r.dur/rows[0].dur*100)}%"></div>`:''}</span><span class="time" style="color:var(--muted)">${formatTime(r.ts-state.info.start,true)} ↗</span></button>`).join(''):'<p class="empty-state">沒有符合的事件。試試不同的關鍵字。</p>');
}
function navigateRecord(r){setView('timeline');if(state.filter){state.filter='';$('track-filter').value='';updateLayout();}selectRecord(r,true);focusSelection();}
function search(){const term=$('search-input').value.trim();if(!state.info||!term)return;state.searchId++;$('search-results').innerHTML='<p class="empty-state">正在背景搜尋磁碟索引…</p>';send('search',{requestId:state.searchId,term});}
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
      const ids=state.layout.filter(r=>r.y+r.h>=top+Math.min(pointer.y,p.y)&&r.y<=top+Math.max(pointer.y,p.y)).map(r=>r.track.id);
      showArea(pointer.mode==='edge'&&pointer.edge==='start'?edgeTime:start,pointer.mode==='edge'&&pointer.edge==='end'?edgeTime:end,pointer.mode==='edge'?state.area.trackIds:ids);
    }return;
  }
  const hit=hitboxes.findLast(h=>p.x>=h.x&&p.x<=h.x+h.w&&p.y>=h.y&&p.y<=h.y+h.h);
  if(hit){$('tooltip').innerHTML=`${esc(hit.record.label)}<small>${formatTime(hit.record.dur||0)}${hit.record.kind===2?` · value ${hit.record.value.toFixed(2)}`:''}${hit.record.n>1?` · 聚合 ${hit.record.n} 筆，放大可展開`:''}</small>`;$('tooltip').hidden=false;$('tooltip').style.left=`${Math.min(innerWidth-350,e.clientX+14)}px`;$('tooltip').style.top=`${Math.min(innerHeight-80,e.clientY+15)}px`;}else $('tooltip').hidden=true;
});
$('timeline').addEventListener('pointerup',e=>{if(!pointer)return;const p=localPoint(e);if(!pointer.moved){const hit=hitboxes.findLast(h=>p.x>=h.x&&p.x<=h.x+h.w&&p.y>=h.y&&p.y<=h.y+h.h);if(hit)selectRecord(hit.record);else clearSelection();}pointer=null;});
$('timeline').addEventListener('pointercancel',()=>pointer=null);$('timeline').addEventListener('pointerleave',()=>$('tooltip').hidden=true);
$('timeline').addEventListener('dblclick',()=>focusSelection());
$('tracks-scroll').addEventListener('wheel',e=>{if(!state.info)return;if(e.ctrlKey||e.metaKey){e.preventDefault();zoom(1-wheelZoomRatio(e.deltaY),Math.max(0,Math.min(1,(e.clientX-$('timeline').getBoundingClientRect().left)/plotWidth)));}else if(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)){e.preventDefault();pan((e.deltaX||e.deltaY)/plotWidth);}},{passive:false});
$('tracks-scroll').addEventListener('scroll',()=>{renderLabels();requestQuery();},{passive:true});
$('overview-wrap').addEventListener('pointerdown',e=>{if(!state.info)return;overviewPointer={x:e.clientX,start:state.start,span:state.end-state.start};e.currentTarget.setPointerCapture(e.pointerId);const r=e.currentTarget.getBoundingClientRect(),t=state.info.start+(e.clientX-r.left)/r.width*(state.info.end-state.info.start);setRange(t-overviewPointer.span/2,t+overviewPointer.span/2);overviewPointer.start=state.start;});
$('overview-wrap').addEventListener('pointermove',e=>{if(!overviewPointer)return;const delta=(e.clientX-overviewPointer.x)/e.currentTarget.clientWidth*(state.info.end-state.info.start);setRange(overviewPointer.start+delta,overviewPointer.start+delta+overviewPointer.span);});
for(const evt of ['pointerup','pointercancel'])$('overview-wrap').addEventListener(evt,()=>overviewPointer=null);
$('track-labels').addEventListener('click',e=>{const pin=e.target.closest('[data-pin]');if(pin){const id=Number(pin.dataset.pin);if(state.pins.has(id))state.pins.delete(id);else state.pins.add(id);updateLayout();$('tracks-scroll').scrollTop=0;}});
$('track-labels').addEventListener('dblclick',e=>{const label=e.target.closest('[data-track]');if(label){const id=Number(label.dataset.track);if(state.expanded.has(id))state.expanded.delete(id);else state.expanded.add(id);updateLayout();}});
$('track-filter').addEventListener('input',e=>{state.filter=e.target.value;updateLayout();});$('reset-filter').onclick=()=>{$('track-filter').value='';state.filter='';updateLayout();};
document.querySelectorAll('.nav').forEach(e=>e.onclick=()=>setView(e.dataset.view));
$('open').onclick=()=>$('file').click();$('file').onchange=e=>{loadFile(e.target.files[0]);e.target.value='';};$('demo').onclick=loadDemo;
$('zoom-in').onclick=()=>zoom(.65);$('zoom-out').onclick=()=>zoom(1/.65);$('fit').onclick=fitAll;$('focus-selection').onclick=focusSelection;
$('toggle-details').onclick=()=>$('details').hidden=!$('details').hidden;
$('copy').onclick=async()=>{if(!state.detail){toast('請先選取事件。');return;}try{await navigator.clipboard.writeText(state.detail.rawText);toast('已複製原始事件 JSON。');}catch{toast('瀏覽器未允許剪貼簿存取，可展開原始 JSON 手動複製。');}};
$('details-content').addEventListener('click',e=>{const relation=e.target.closest('[data-relation]');if(relation){const r=state.links[Number(relation.dataset.relation)]?.record;if(r)navigateRecord(r);}if(e.target.closest('#show-relations')){state.showLinks=!state.showLinks;renderDetail();paint();}if(e.target.closest('#area-focus'))focusSelection();});
for(const id of ['search-results','insights-list'])$(id).addEventListener('click',e=>{const button=e.target.closest('[data-result]');if(button){const r=(button.dataset.source==='search'?searchResults:state.info.top)[Number(button.dataset.result)];navigateRecord(r);}});
$('search-form').onsubmit=e=>{e.preventDefault();search();};
function openHelp(){if(!$('help').open)$('help').showModal();}
$('shortcuts').onclick=openHelp;$('help-link').onclick=openHelp;
document.querySelectorAll('[data-close]').forEach(e=>e.onclick=()=>$(e.dataset.close).close());
$('storage').onclick=async()=>{const q=await navigator.storage.estimate().catch(()=>({}));$('storage-usage').textContent=q.usage!==undefined?`本站已用 ${bytes(q.usage)} / 額度 ${bytes(q.quota||0)}`:'無法讀取儲存額度。';$('cache-dialog').showModal();};
$('clear-cache').onclick=()=>{startWorker();send('clear');};
$('cancel').onclick=()=>{startWorker();finishLoading();toast('已取消。未完成的快取可從左側「清除 Trace 快取」移除。');const last=localStorage.getItem('trace-studio-session');if(last)send('restore',{id:last});else loadDemo();};
$('theme').onclick=()=>{document.body.classList.toggle('dark');try{localStorage.setItem('trace-studio-theme',document.body.classList.contains('dark')?'dark':'light');}catch{}paint();drawOverview();};
const commands=[['開啟 Trace 檔案','O',()=>$('file').click()],['顯示完整 Trace','',fitAll],['聚焦目前選取','F',focusSelection],['放大時間軸','W',()=>zoom(.65)],['縮小時間軸','S',()=>zoom(1/.65)],['搜尋事件名稱','/',()=>setView('events')],['尋找軌道','Ctrl P',()=>{setView('timeline');$('track-filter').focus();}],['切換詳情面板','Q',()=>$('details').hidden=!$('details').hidden],['切換深色模式','',()=>$('theme').click()],['Trace 資訊','',()=>setView('info')],['操作與快捷鍵','?',openHelp]];
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
try{if(localStorage.getItem('trace-studio-theme')==='dark')document.body.classList.add('dark');}catch{}
startWorker();const last=(()=>{try{return localStorage.getItem('trace-studio-session');}catch{return null;}})();if(last){beginLoading('從本機索引還原');send('restore',{id:last});}else loadDemo();
