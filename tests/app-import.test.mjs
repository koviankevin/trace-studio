import {removeTestRoot} from './temp-files.mjs';
// Runs the actual application entry point and Worker protocol in Node.
// The DOM/Canvas are substitutes; this does not replace browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker as NodeWorker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';

test('application startup and file selection reach the loaded timeline',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-app-')),workers=[],errors=[],frames=[];
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const classList=()=>{const values=new Set();return {contains:x=>values.has(x),add:x=>values.add(x),toggle(x,on){if(on??!values.has(x))values.add(x);else values.delete(x);}};};
  const canvasLabels=[],canvas=new Proxy({measureText:text=>({width:String(text).length*7}),fillText:text=>canvasLabels.push(text)},{get:(o,k)=>o[k]||(()=>{})});
  function element(id){return {id,style:{setProperty(){}},classList:classList(),dataset:{},value:'',textContent:'',innerHTML:'',hidden:false,open:false,scrollTop:0,clientWidth:1100,clientHeight:400,parentElement:{clientHeight:30},handlers:{},addEventListener(type,fn){const previous=this.handlers[type];this.handlers[type]=previous?event=>{previous(event);fn(event);}:fn;},setAttribute(){},setPointerCapture(){},getBoundingClientRect:()=>({width:1100,height:400,left:0,top:0}),getContext:()=>canvas,showModal(){this.open=true;},close(){this.open=false;},click(){this.onclick?.();},focus(){}};}
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],element(m[1])]));
  elements.get('analysis-threshold').value='1';elements.get('analysis-scope').value='all';elements.get('analysis-group').value='all';elements.get('include-arguments').checked=true;
  const storage=new Map();
  Object.assign(globalThis,{
    document:{getElementById:id=>elements.get(id),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},body:{classList:classList()},documentElement:{}},
    window:{handlers:{},addEventListener(type,fn){this.handlers[type]=fn;}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    innerWidth:1280,innerHeight:800,devicePixelRatio:1,
    getComputedStyle:()=>({getPropertyValue:()=>250}),
    requestAnimationFrame:callback=>{frames.push(callback);return frames.length;},
    ResizeObserver:class{observe(){}},
    Worker:class{
      constructor(){workers.push(this);this.native=new NodeWorker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});this.ready=false;this.pending=[];this.native.on('error',error=>errors.push(error));this.native.on('message',data=>{
        if(data.type==='initialized'){this.ready=true;for(const data of this.pending)this.native.postMessage(data);this.pending=[];return;}
        if(data.type==='ready'){this.lastReady=data;(this.readies??=[]).push(data);}
        if(data.type==='query')this.lastQuery=data;
        try{this.onmessage?.({data});}catch(error){errors.push(error);}
      });}
      postMessage(data){if(this.ready)this.native.postMessage(data);else this.pending.push(data);}
      terminate(){this.stopped=this.native.terminate();return this.stopped;}
    }
  });
  async function until(predicate){for(let i=0;i<200;i++){if(errors.length)throw errors[0];if(predicate())return;await delay(10);}assert.fail('application did not finish loading');}
  function draw(){for(const callback of frames.splice(0))callback(performance.now());}
  try{
    await import('../dist/app.js');
    await until(()=>elements.get('file-name').textContent==='core-four-core.demo.json');draw();
    assert.equal(elements.get('loading').open,false);
    const input=elements.get('file');input.files=[new File(['{"traceEvents":[{"name":"Actual file","ph":"X","ts":10,"dur":50,"pid":1,"tid":2}]}'],'input.json')];
    input.onchange({target:input});
    workers.at(-1).onmessage({data:{type:'error',operation:'search',requestId:-1,traceId:'previous-trace',message:'stale search failure'}});
    assert.equal(elements.get('loading').open,true,'a retired search error must not dismiss the current import');
    await until(()=>elements.get('file-name').textContent==='input.json');draw();
    assert.equal(elements.get('loading').open,false);
    assert.equal(elements.get('events-count').textContent,'1');
    assert.match(elements.get('track-labels').innerHTML,/>2<\/span>/);
    assert(!elements.get('track-labels').innerHTML.includes('#2'));
    assert.equal(input.value,'');
    input.files=[new File([JSON.stringify({traceEvents:[{ph:'X',pid:1,tid:2,ts:0,dur:50},{ph:'M',pid:1,tid:2,name:'thread_name',args:{name:'CORE0_COMPUTE'}}]})],'unnamed.json')];
    input.onchange({target:input});await until(()=>elements.get('file-name').textContent==='unnamed.json');draw();
    elements.get('insights-list').handlers.click({target:{closest:()=>({dataset:{source:'top',result:'0'}})}});
    await until(()=>elements.get('details-content').innerHTML.includes('完整原始 JSON'));
    assert.equal(elements.get('selection-heading').textContent,'2');
    elements.get('track-filter').value='CORE';elements.get('track-filter').handlers.input({target:elements.get('track-filter')});
    elements.get('runtime-toggle').click();elements.get('zoom-in').click();await until(()=>{draw();return Number(elements.get('runtime-count').textContent)>0;});elements.get('runtime-refresh').click();assert(elements.get('runtime-results').innerHTML.includes('Canvas 更新 P50 / P95'));const captured=JSON.parse(elements.get('runtime-json').value);assert(captured.completedFrames>0);assert.equal(captured.trace.events,2);assert(!elements.get('runtime-json').value.includes('unnamed.json'));assert(!('source'in captured));elements.get('runtime-toggle').click();draw();const beforePan=elements.get('window-time').textContent;
    elements.get('timeline').handlers.pointerdown({button:0,clientX:500,clientY:104,pointerId:2,shiftKey:true});elements.get('timeline').handlers.pointermove({clientX:400,clientY:104});elements.get('timeline').handlers.pointerup({clientX:400,clientY:104});draw();
    assert.notEqual(elements.get('window-time').textContent,beforePan,'Shift drag must pan the existing time window');
    const beforeWheel=elements.get('window-time').textContent;let wheelPrevented=false;elements.get('tracks-scroll').handlers.wheel({ctrlKey:true,deltaY:-120,clientX:400,preventDefault(){wheelPrevented=true;}});draw();
    assert(wheelPrevented);assert.notEqual(elements.get('window-time').textContent,beforeWheel,'Ctrl wheel must zoom without browser page scrolling');const priorWindow=elements.get('window-time').textContent;
    // Cancel before a new worker can finish the next import, including Esc.
    input.files=[new File(['[]'],'cancelled.json')];input.onchange({target:input});
    let prevented=false;elements.get('loading').handlers.cancel({preventDefault(){prevented=true;}});
    assert(prevented);await until(()=>elements.get('toast').textContent.includes('已返回上一份 Trace'));
    assert.equal(elements.get('file-name').textContent,'unnamed.json');
    assert.equal(elements.get('loading').open,false);
    assert.equal(elements.get('selection-heading').textContent,'2');
    draw();assert.equal(elements.get('track-filter').value,'CORE');assert.equal(elements.get('window-time').textContent,priorWindow);
    assert.match(elements.get('details-content').innerHTML,/<h3>2<\/h3>/);
    const retired=workers.at(-1);
    input.files=[new File(['{"traceEvents":[{'],'broken.json')];input.onchange({target:input});
    // A late ready from the retired worker must not clear the recovery state.
    retired.onmessage({data:retired.lastReady});
    await until(()=>elements.get('toast').textContent.includes('不完整'));
    await until(()=>elements.get('file-name').textContent==='unnamed.json'&&!elements.get('loading').open);
    assert.equal(elements.get('events-count').textContent,'2');
    elements.get('insights-list').handlers.click({target:{closest:()=>({dataset:{source:'top',result:'0'}})}});
    await until(()=>elements.get('details-content').innerHTML.includes('完整原始 JSON'));
    assert.equal(elements.get('selection-heading').textContent,'2');
    const inputCache=workers.flatMap(worker=>worker.readies||[]).map(ready=>ready.info).find(info=>info?.source.name==='input.json').id;
    elements.get('track-filter').value='CORE';elements.get('track-filter').handlers.input({target:elements.get('track-filter')});elements.get('zoom-in').click();draw();const quotaWindow=elements.get('window-time').textContent;
    const quotaWorker=workers.at(-1);const faultConfigured=new Promise(resolve=>{const receive=data=>{if(data.type==='testWriteFaultConfigured'){quotaWorker.native.off('message',receive);resolve();}};quotaWorker.native.on('message',receive);});quotaWorker.native.postMessage({type:'testWriteFault',name:'session.json'});await faultConfigured;
    input.files=[new File(['[{"ph":"X","name":"quota failure","pid":1,"tid":1,"ts":0,"dur":1}]'],'quota.json')];input.onchange({target:input});await until(()=>elements.get('toast').textContent.includes('額度不足'));await until(()=>elements.get('file-name').textContent==='unnamed.json'&&!elements.get('loading').open);draw();assert.equal(elements.get('events-count').textContent,'2');assert.equal(elements.get('track-filter').value,'CORE');assert.equal(elements.get('window-time').textContent,quotaWindow);assert.equal(workers.at(-1),quotaWorker,'quota recovery must preserve the worker and previous trace');
    elements.get('storage').click();await until(()=>elements.get('cache-list').innerHTML.includes(inputCache));
    assert(elements.get('cache-dialog').open);assert.match(elements.get('cache-list').innerHTML,/目前開啟/);
    const cacheWorker=workers.at(-1);elements.get('cache-list').handlers.click({target:{closest:selector=>selector==='[data-cache-open]'?{dataset:{cacheOpen:inputCache}}:null}});
    await until(()=>elements.get('file-name').textContent==='input.json'&&!elements.get('loading').open);
    assert.equal(elements.get('events-count').textContent,'1');
    assert.equal(workers.at(-1),cacheWorker,'cache dialog restore must keep the worker and its leases');
    elements.get('storage').click();await until(()=>elements.get('cache-status').textContent.includes('份快取'));
    elements.get('clear-unused').click();await until(()=>elements.get('cache-status').textContent.startsWith('已清除'));
    assert.equal(elements.get('file-name').textContent,'input.json');assert.match(elements.get('cache-list').innerHTML,/目前開啟/);
    elements.get('cache-dialog').close();
    input.files=[new File([JSON.stringify([{ph:'C',name:'Power',pid:1,tid:1,ts:0,args:{watts:.000001}},{ph:'C',name:'Power',pid:1,tid:1,ts:1000,args:{watts:.000002}}])],'counter.json')];
    input.onchange({target:input});await until(()=>elements.get('file-name').textContent==='counter.json');elements.get('expand-groups').click();
    await until(()=>workers.at(-1).lastQuery?.rows.some(track=>track.rows.some(record=>record.kind===2)));draw();
    assert(canvasLabels.includes('1e-6')&&canvasLabels.includes('2e-6'),'axis labels must not round small values to zero');
    elements.get('timeline').handlers.pointerdown({button:0,clientX:0,clientY:104,pointerId:1});elements.get('timeline').handlers.pointerup({clientX:0,clientY:104});
    await until(()=>elements.get('details-content').innerHTML.includes('<dt>數值</dt><dd>1e-6</dd>'));
    const memory=(start,role)=>({RangeStart:start,Size:256,Space:`LOC_${role}_LOCAL`});
    input.files=[new File([JSON.stringify([{ph:'X',pid:'CORE0',tid:'CORE0_COMPUTE',ts:0,dur:10,args:{TfliteID:7,LinkId:42,CoreId:0,MemoryRanges:memory('0x1000','OUTPUT')}},{ph:'X',pid:'CORE0',tid:'CORE0_DMA',ts:20,dur:5,args:{TfliteID:7,LinkId:42,CoreId:0,MemoryRanges:memory('0x1080','INPUT')}},{ph:'X',name:'Compute',pid:'CORE1',tid:'CORE1_COMPUTE',ts:20,dur:4,args:{TfliteID:7,LinkId:43,CoreId:1,MemoryRanges:memory('0x1000','OUTPUT')}}])],'args.json')];
    input.onchange({target:input});await until(()=>elements.get('file-name').textContent==='args.json');
    elements.get('insights-list').handlers.click({target:{closest:()=>({dataset:{source:'top',result:'0'}})}});
    await until(()=>elements.get('details-content').innerHTML.includes('分析同 TfliteID 7'));assert.equal(elements.get('selection-heading').textContent,'COMPUTE');
    elements.get('details-content').handlers.click({target:{closest:selector=>selector==='[data-argument-focus]'?{dataset:{argumentFocus:'tflite'}}:null}});
    await until(()=>elements.get('analysis-results').innerHTML.includes('同 TfliteID 7'));assert(elements.get('analysis-results').innerHTML.includes('1–3 / 3'));
    elements.get('analysis-results').onclick({target:{closest:selector=>selector==='[data-argument-kind]'?{dataset:{argumentKind:'flow',argumentId:'42'}}:null}});
    await until(()=>elements.get('analysis-results').innerHTML.includes('同 LinkId 42'));assert(elements.get('analysis-results').innerHTML.includes('1–2 / 2'));
    elements.get('analysis-results').onclick({target:{closest:selector=>selector==='[data-argument-member]'?{dataset:{argumentMember:'0'}}:null}});
    await until(()=>elements.get('details-content').innerHTML.includes('比對記憶體範圍'));
    elements.get('details-content').handlers.click({target:{closest:selector=>selector==='[data-argument-focus]'?{dataset:{argumentFocus:'memory'}}:null}});
    await until(()=>elements.get('analysis-results').innerHTML.includes('記憶體範圍候選'));
    assert(elements.get('analysis-results').innerHTML.includes('重疊 128 B'));assert(elements.get('analysis-results').innerHTML.includes('來源輸出→候選輸入'));assert(elements.get('analysis-results').innerHTML.includes('1–1 / 1'));
    elements.get('argument-cross-process').checked=true;elements.get('analysis-form').onsubmit({preventDefault(){}});
    await until(()=>elements.get('analysis-results').innerHTML.includes('所有程序／核心'));assert(elements.get('analysis-results').innerHTML.includes('1–2 / 2'));
    const priorWorkers=workers.length;
    const compareFile=(name,ts,dur)=>new File([JSON.stringify([{name:'compute',ph:'X',pid:1,tid:1,ts,dur,args:{TfliteID:7,CoreId:0}}])],name);
    input.files=[compareFile('before.json',1000,10),compareFile('after.json',9000,20)];input.onchange({target:input});
    await until(()=>elements.get('file-name').textContent==='after.json'&&elements.get('trace-tabs').innerHTML.includes('before.json'));
    assert.equal(workers.length,priorWorkers,'batch loading must preserve small indexes in the existing worker');
    const readyFiles=workers.at(-1).readies,first=readyFiles.find(ready=>ready.info.source.name==='before.json').info.id,second=readyFiles.find(ready=>ready.info.source.name==='after.json').info.id;
    elements.get('open-comparison').click();await until(()=>elements.get('comparison-sources').innerHTML.includes(first)&&elements.get('comparison-sources').innerHTML.includes(second));
    for(const match of elements.get('comparison-sources').innerHTML.matchAll(/data-comparison-id="([^"]+)"/g))elements.get('comparison-sources').onchange({target:{dataset:{comparisonId:match[1]},checked:false}});
    for(const id of [first,second])elements.get('comparison-sources').onchange({target:{dataset:{comparisonId:id},checked:true}});
    elements.get('comparison-id').value='7';elements.get('comparison-form').onsubmit({preventDefault(){}});
    await until(()=>elements.get('comparison-status').textContent.startsWith('比較完成'));
    assert(elements.get('comparison-results').innerHTML.includes('before.json'));assert(elements.get('comparison-results').innerHTML.includes('after.json'));assert(elements.get('comparison-results').innerHTML.includes('100.0%'));
    elements.get('comparison-id').value='';elements.get('comparison-form').onsubmit({preventDefault(){}});await until(()=>elements.get('comparison-status').textContent.startsWith('比較完成'));assert(elements.get('comparison-results').innerHTML.includes('圖版本比較'));assert(elements.get('comparison-results').innerHTML.includes('data-compare-id="7"'));
    elements.get('comparison-results').onclick({target:{closest:selector=>selector==='[data-compare-id]'?{dataset:{compareId:'7'}}:null}});await until(()=>elements.get('comparison-status').textContent.startsWith('比較完成'));assert(elements.get('comparison-results').innerHTML.includes('TfliteID 7'));
    elements.get('comparison-results').onclick({target:{closest:selector=>selector==='[data-compare-member]'?{dataset:{compareMember:'0:0'}}:null}});
    await until(()=>elements.get('file-name').textContent==='before.json'&&elements.get('selection-heading').textContent==='compute');assert(workers.at(-1).lastReady.memoryRestored);
    elements.get('track-filter').value='1';elements.get('track-filter').handlers.input({target:elements.get('track-filter')});elements.get('zoom-in').click();draw();const savedWindow=elements.get('window-time').textContent;window.handlers.pagehide();
    for(const active of workers)await active.terminate();elements.get('file-name').textContent='Reloading';
    await import('../dist/app.js?workspace-reload=1');await until(()=>elements.get('file-name').textContent==='before.json'&&elements.get('trace-tabs').innerHTML.includes('after.json'));
    assert(!workers.at(-1).lastReady.memoryRestored);draw();assert.equal(elements.get('track-filter').value,'1');assert.equal(elements.get('window-time').textContent,savedWindow);
    elements.get('trace-tabs').onclick({target:{closest:()=>({dataset:{traceOpen:second}})}});await until(()=>elements.get('file-name').textContent==='after.json');
    elements.get('trace-tabs').onclick({target:{closest:()=>({dataset:{traceOpen:first}})}});await until(()=>elements.get('file-name').textContent==='before.json');assert(workers.at(-1).lastReady.memoryRestored);
  }finally{await Promise.all(workers.map(w=>w.stopped||w.terminate()));await removeTestRoot(root);}
});
