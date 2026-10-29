// Bounded local diagnostics. No event data, filenames, network or polling timer.
const summary=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b),n=sorted.length;return {samples:n,medianMs:n?sorted[Math.floor((n-1)*.5)]:null,p95Ms:n?sorted[Math.floor((n-1)*.95)]:null,maxMs:n?sorted[n-1]:null};};
export class RuntimeMetrics{
  constructor({clock=()=>performance.now(),readHeap=()=>globalThis.performance?.memory?.usedJSHeapSize,visible=()=>true,Observer=globalThis.PerformanceObserver,limit=512}={}){
    if(!Number.isInteger(limit)||limit<1||limit>4096)throw Error('Invalid metrics window');
    Object.assign(this,{clock,readHeap,visible,Observer,limit,enabled:false,observer:null});this.reset();
  }
  reset(){this.startedAt=this.clock();this.stoppedAt=null;this.generation=(this.generation||0)+1;this.latest=null;this.response=null;this.requests=new Map();this.frames=[];this.queries=[];this.frameCount=0;this.queryCount=0;this.intents=0;this.coalesced=0;this.hidden=0;this.heapLast=null;this.heapMax=null;this.longTasks={supported:!!this.observer,count:0,totalMs:0,maxMs:0};this.sampleHeap();}
  start(){this.stop();this.enabled=true;this.reset();
    try{if(this.Observer?.supportedEntryTypes?.includes('longtask')){this.observer=new this.Observer(list=>this.addLongTasks(list.getEntries()));this.observer.observe({type:'longtask'});this.longTasks.supported=true;}}catch{this.observer?.disconnect();this.observer=null;}
  }
  stop(){if(this.enabled){this.addLongTasks(this.observer?.takeRecords?.()||[]);this.sampleHeap();this.stoppedAt=this.clock();}this.enabled=false;this.observer?.disconnect();this.observer=null;this.latest=null;this.requests.clear();}
  cancelPending(){this.latest=null;this.response=null;this.requests.clear();this.generation++;}
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
  snapshot(){this.sampleHeap();return {version:1,enabled:this.enabled,windowLimit:this.limit,elapsedMs:Math.max(0,(this.stoppedAt??this.clock())-this.startedAt),intents:this.intents,coalescedIntents:this.coalesced,hiddenOmitted:this.hidden,completedFrames:this.frameCount,completedQueries:this.queryCount,canvas:summary(this.frames.map(s=>s.canvasMs)),roundTrip:summary(this.queries.map(s=>s.roundTripMs)),worker:summary(this.queries.map(s=>s.workerMs)),longTasks:{...this.longTasks},heap:{lastBytes:this.heapLast,maxSampledBytes:this.heapMax},observations:{frames:this.frames.map(sample=>({...sample})),queries:this.queries.map(sample=>({...sample}))},notes:['Canvas latency ends when the matching query result is submitted by drawTimeline; it includes debounce/queue time, not compositor presentation or FPS.','Only completed latest-state updates are sampled; coalesced intents and hidden-page observations are counted separately. Quantiles use floor((n-1)*p) over the bounded recent window.','JS heap is an optional browser-provided approximation, may exclude Worker heaps or include shared heaps, and is not total browser peak memory.']};}
}
