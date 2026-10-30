// Bounded local diagnostics. No event data, filenames, network or polling timer.
const summary=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b),n=sorted.length;return {samples:n,medianMs:n?sorted[Math.floor((n-1)*.5)]:null,p95Ms:n?sorted[Math.floor((n-1)*.95)]:null,maxMs:n?sorted[n-1]:null};};
export class RuntimeMetrics{
  constructor({clock=()=>performance.now(),readHeap=()=>globalThis.performance?.memory?.usedJSHeapSize,visible=()=>true,Observer=globalThis.PerformanceObserver,limit=512,inputLimit=64}={}){
    if(!Number.isInteger(limit)||limit<1||limit>4096)throw Error('Invalid metrics window');
    if(!Number.isInteger(inputLimit)||inputLimit<1||inputLimit>256)throw Error('Invalid input window');
    Object.assign(this,{clock,readHeap,visible,Observer,limit,inputLimit,enabled:false,observer:null});this.reset();
  }
  reset(){this.startedAt=this.clock();this.stoppedAt=this.enabled?null:this.startedAt;this.generation=(this.generation||0)+1;this.inputEpoch=(this.inputEpoch||0)+1;this.inputLog=[];this.inputCount=0;this.inputTotals={trustedCtrlWheels:0,zoomedCtrlWheels:0,trustedShiftDrags:0,pannedShiftDrags:0};this.latest=null;this.response=null;this.requests=new Map();this.frames=[];this.queries=[];this.frameCount=0;this.queryCount=0;this.intents=0;this.coalesced=0;this.hidden=0;this.heapLast=null;this.heapMax=null;this.longTasks={supported:!!this.observer,count:0,totalMs:0,maxMs:0};this.sampleHeap();}
  start(){this.stop();this.enabled=true;this.reset();
    try{if(this.Observer?.supportedEntryTypes?.includes('longtask')){this.observer=new this.Observer(list=>this.addLongTasks(list.getEntries()));this.observer.observe({type:'longtask'});this.longTasks.supported=true;}}catch{this.observer?.disconnect();this.observer=null;}
  }
  stop(){if(this.enabled){this.addLongTasks(this.observer?.takeRecords?.()||[]);this.sampleHeap();this.stoppedAt=this.clock();}this.enabled=false;this.inputEpoch++;this.observer?.disconnect();this.observer=null;this.latest=null;this.requests.clear();}
  cancelPending(){this.latest=null;this.response=null;this.requests.clear();this.generation++;this.inputEpoch++;}
  visibilityChanged(){if(this.enabled&&!this.visible()){if(this.latest)this.hidden++;this.cancelPending();}}
  sampleHeap(){if(!this.enabled)return;try{const bytes=this.readHeap();if(Number.isFinite(bytes)&&bytes>=0){this.heapLast=bytes;this.heapMax=Math.max(this.heapMax||0,bytes);}}catch{}}
  addLongTasks(entries){if(!this.enabled)return;for(const entry of entries)if(entry.startTime>=this.startedAt&&Number.isFinite(entry.duration)&&entry.duration>=50){this.longTasks.count++;this.longTasks.totalMs+=entry.duration;this.longTasks.maxMs=Math.max(this.longTasks.maxMs,entry.duration);}}
  intent(){if(!this.enabled)return;this.intents++;if(!this.visible()){this.hidden++;this.latest=null;return;}if(this.latest)this.coalesced++;this.latest={token:++this.generation,at:this.clock()};}
  sent(id){if(!this.enabled)return;this.requests.set(id,{token:this.latest?.token,at:this.clock()});if(this.requests.size>8)this.requests.delete(this.requests.keys().next().value);}
  received(id,workerMs){if(!this.enabled)return;const request=this.requests.get(id);if(!request)return;this.requests.delete(id);const sample={roundTripMs:Math.max(0,this.clock()-request.at),workerMs:Number.isFinite(workerMs)&&workerMs>=0?workerMs:null};this.response={id,token:request.token,...sample};this.queryCount++;this.queries.push(sample);if(this.queries.length>this.limit)this.queries.shift();this.sampleHeap();}
  frame(id){if(!this.enabled||!this.latest||this.response?.id!==id||this.response.token!==this.latest.token)return false;
    if(!this.visible()){this.hidden++;this.latest=null;return false;}
    this.frames.push({canvasMs:Math.max(0,this.clock()-this.latest.at),roundTripMs:this.response.roundTripMs,workerMs:this.response.workerMs});if(this.frames.length>this.limit)this.frames.shift();this.frameCount++;this.latest=null;this.sampleHeap();return true;
  }
  input(kind,data){
    if(!this.enabled||!this.visible()||!data||data.epoch!==undefined&&data.epoch!==this.inputEpoch)return false;
    const allowed=kind==='wheel'?['zoom','pan','scroll']:kind==='pointer'?['pan','area','edge','click','cancelled']:[];
    if(!allowed.includes(data.action))return false;
    const {beforeStart,beforeEnd,afterStart,afterEnd}=data;
    if(![beforeStart,beforeEnd,afterStart,afterEnd].every(Number.isFinite))return false;
    const beforeSpanUs=beforeEnd-beforeStart,afterSpanUs=afterEnd-afterStart,panDeltaUs=afterStart-beforeStart;
    if(![beforeSpanUs,afterSpanUs,panDeltaUs].every(Number.isFinite)||beforeSpanUs<=0||afterSpanUs<=0)return false;
    const sample={kind,atMs:Math.max(0,this.clock()-this.startedAt),isTrusted:data.isTrusted===true,ctrlKey:data.ctrlKey===true,metaKey:data.metaKey===true,shiftKey:data.shiftKey===true,action:data.action,moved:data.moved===true,cancelled:data.cancelled===true,beforeSpanUs,afterSpanUs,panDeltaUs,rangeChanged:panDeltaUs!==0||beforeSpanUs!==afterSpanUs};
    this.inputLog.push(sample);if(this.inputLog.length>this.inputLimit)this.inputLog.shift();this.inputCount++;
    const sameSpan=Math.abs(beforeSpanUs-afterSpanUs)<=Math.max(1e-6,beforeSpanUs*1e-9,afterSpanUs*1e-9);
    if(sample.isTrusted&&!sample.cancelled){
      if(kind==='wheel'&&(sample.ctrlKey||sample.metaKey)){this.inputTotals.trustedCtrlWheels++;if(sample.action==='zoom'&&!sameSpan)this.inputTotals.zoomedCtrlWheels++;}
      if(kind==='pointer'&&sample.shiftKey&&sample.moved){this.inputTotals.trustedShiftDrags++;if(sample.action==='pan'&&sameSpan&&panDeltaUs!==0)this.inputTotals.pannedShiftDrags++;}
    }
    return true;
  }
  snapshot(){this.sampleHeap();return {version:2,enabled:this.enabled,windowLimit:this.limit,elapsedMs:Math.max(0,(this.stoppedAt??this.clock())-this.startedAt),intents:this.intents,coalescedIntents:this.coalesced,hiddenOmitted:this.hidden,completedFrames:this.frameCount,completedQueries:this.queryCount,canvas:summary(this.frames.map(s=>s.canvasMs)),roundTrip:summary(this.queries.map(s=>s.roundTripMs)),worker:summary(this.queries.map(s=>s.workerMs)),longTasks:{...this.longTasks},heap:{lastBytes:this.heapLast,maxSampledBytes:this.heapMax},inputs:{windowLimit:this.inputLimit,recorded:this.inputCount,...this.inputTotals,recent:this.inputLog.map(sample=>({...sample}))},observations:{frames:this.frames.map(sample=>({...sample})),queries:this.queries.map(sample=>({...sample}))},notes:['Canvas latency ends when the matching query result is submitted by drawTimeline; it includes debounce/queue time, not compositor presentation or FPS.','Only completed latest-state updates are sampled; coalesced intents and hidden-page observations are counted separately. Quantiles use floor((n-1)*p) over the bounded recent window.','JS heap is an optional browser-provided approximation, may exclude Worker heaps or include shared heaps, and is not total browser peak memory.','Input samples keep modifier flags, spans and relative shifts only. Trusted browser input does not certify physical hardware, completed rendering or an entire compatibility test.']};}
}
