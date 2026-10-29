// Runs the actual application entry point and Worker protocol in Node.
// The DOM/Canvas are substitutes; this does not replace browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker as NodeWorker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';

test('application startup and file selection reach the loaded timeline',async()=>{
  const root=await mkdtemp(join(tmpdir(),'trace-app-')),workers=[],errors=[],frames=[];
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const classList=()=>{const values=new Set();return {contains:x=>values.has(x),add:x=>values.add(x),toggle(x,on){if(on??!values.has(x))values.add(x);else values.delete(x);}};};
  const canvas=new Proxy({measureText:text=>({width:String(text).length*7})},{get:(o,k)=>o[k]||(()=>{})});
  function element(id){return {id,style:{setProperty(){}},classList:classList(),dataset:{},value:'',textContent:'',innerHTML:'',hidden:false,open:false,scrollTop:0,clientWidth:1100,clientHeight:400,parentElement:{clientHeight:30},handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},setAttribute(){},getBoundingClientRect:()=>({width:1100,height:400,left:0,top:0}),getContext:()=>canvas,showModal(){this.open=true;},close(){this.open=false;},click(){this.onclick?.();},focus(){}};}
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],element(m[1])]));
  const storage=new Map();
  Object.assign(globalThis,{
    document:{getElementById:id=>elements.get(id),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},body:{classList:classList()},documentElement:{}},
    window:{addEventListener(){}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    innerWidth:1280,innerHeight:800,devicePixelRatio:1,
    getComputedStyle:()=>({getPropertyValue:()=>250}),
    requestAnimationFrame:callback=>{frames.push(callback);return frames.length;},
    ResizeObserver:class{observe(){}},
    Worker:class{
      constructor(){workers.push(this);this.native=new NodeWorker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{root}});this.ready=false;this.pending=[];this.native.on('error',error=>errors.push(error));this.native.on('message',data=>{
        if(data.type==='initialized'){this.ready=true;for(const data of this.pending)this.native.postMessage(data);this.pending=[];return;}
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
    assert.equal(elements.get('selection-heading').textContent,'CORE0_COMPUTE');
    assert.match(elements.get('details-content').innerHTML,/<h3>CORE0_COMPUTE<\/h3>/);
  }finally{await Promise.all(workers.map(w=>w.stopped||w.terminate()));await rm(root,{recursive:true});}
});
