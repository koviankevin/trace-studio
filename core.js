// Browser-independent streaming parser and disk-backed trace index. Timestamps are µs.
import {fallbackEventName,missingEventName} from './event-labels.js?v=0.4.0';
const WS = /\s/;
export class TraceJSONReader {
  constructor(onEvent, onMetadata = () => {}) {
    this.onEvent = onEvent; this.onMetadata = onMetadata;
    this.state = 'start'; this.token = ''; this.depth = 0; this.quoted = false;
    this.escape = false; this.key = ''; this.sawEvents = false; this.valueKind = '';
    this.events = 0; this.maxToken = 32 * 1024 * 1024;
  }
  fail(message) { throw new Error(`JSON 格式錯誤：${message}（已讀 ${this.events.toLocaleString()} 筆）`); }
  feed(text) {
    let segment = -1;
    for (let i=0;i<text.length;i++) {
      const c=text[i];
      if (this.state === 'value' || this.state === 'key') {
        if (segment < 0) segment=i;
        if (!this.quoted && this.depth === 0 && this.valueKind === 'primitive' && (c===',' || c==='}' || c===']' || WS.test(c))) {
          this.token += text.slice(segment,i); segment=-1; this.finishValue(); i--; continue;
        }
        if (this.quoted) {
          if (this.escape) this.escape=false;
          else if (c==='\\') this.escape=true;
          else if (c==='"') this.quoted=false;
        } else if(c==='"') this.quoted=true;
        else if(c==='{' || c==='[') this.depth++;
        else if(c==='}' || c===']') this.depth--;
        const complete = !this.quoted && this.depth === 0 && this.valueKind !== 'primitive';
        if (complete) {
          this.token += text.slice(segment,i+1); segment=-1; this.finishValue();
        }
        continue;
      }
      if (WS.test(c) || (this.state==='start' && c==='\uFEFF')) continue;
      switch(this.state) {
        case 'start':
          if(c==='[') { this.rootArray=true; this.sawEvents=true; this.state='eventFirst'; }
          else if(c==='{') this.state='rootFirst'; else this.fail('需要陣列或含 traceEvents 的物件'); break;
        case 'rootFirst': case 'rootKey':
          if(c==='}' && this.state==='rootFirst') { this.state='done'; break; }
          if(c!=='"') this.fail('預期屬性名稱');
          this.beginValue('key',c); segment=i; i--; break;
        case 'colon': if(c!==':') this.fail('缺少冒號'); this.state='rootValue'; break;
        case 'rootValue':
          if(this.key==='traceEvents') {
            if(this.sawEvents) this.fail('重複 traceEvents');
            if(c!=='[') this.fail('traceEvents 必須是陣列');
            this.sawEvents=true; this.state='eventFirst';
          } else { this.beginValue('value',c,'meta'); segment=i; i--; } break;
        case 'eventFirst': case 'eventNext':
          if(c===']' && this.state==='eventFirst') { this.state=this.rootArray?'done':'rootAfter'; break; }
          if(c!=='{') this.fail('traceEvents 的每一筆必須是物件');
          this.beginValue('value',c,'event'); segment=i; i--; break;
        case 'eventAfter':
          if(c===',') this.state='eventNext';
          else if(c===']') this.state=this.rootArray?'done':'rootAfter';
          else this.fail('事件之間缺少逗號'); break;
        case 'rootAfter':
          if(c===',') this.state='rootKey'; else if(c==='}') this.state='done';
          else this.fail('屬性之間缺少逗號'); break;
        case 'done': this.fail('結尾有額外資料'); break;
      }
    }
    if(segment>=0) this.token+=text.slice(segment);
    if(this.token.length>this.maxToken) this.fail('單筆資料超過 32 MiB，請縮小該筆 args');
  }
  beginValue(state,c,target) {
    this.state=state; this.target=target; this.token=''; this.depth=0;
    this.quoted=false; this.escape=false;
    this.valueKind=c==='{'||c==='['?'container':c==='"'?'string':'primitive';
  }
  finishValue() {
    if(this.token.length>this.maxToken) this.fail('單筆資料超過 32 MiB');
    let value; try {value=JSON.parse(this.token);} catch {this.fail('無法解析資料');}
    if(this.state==='key') { this.key=value; this.state='colon'; }
    else if(this.target==='event') {
      this.onEvent(value,this.token); this.events++; this.state='eventAfter';
    } else { this.onMetadata(this.key,value); this.state='rootAfter'; }
    this.token='';
  }
  end() {
    if(this.state==='value' && this.valueKind==='primitive') this.finishValue();
    if(this.state!=='done') this.fail('檔案不完整');
    if(!this.sawEvents) this.fail('找不到 traceEvents');
  }
}

const encoder=new TextEncoder(), decoder=new TextDecoder();
const RECORD=64, BLOCK=4096, MAX_BUFFER=16384;
export const LIMITS={recordBytes:RECORD,blockEvents:BLOCK,bufferedEvents:MAX_BUFFER,maxNames:65536,maxTracks:8192,maxOpenSpans:100000};
export function hash(value) { let h=2166136261; for(let i=0;i<value.length;i++) h=Math.imul(h^value.charCodeAt(i),16777619); return h>>>0; }
class BufferedFile {
  constructor(handle) {this.handle=handle; this.offset=0;this.buffer=new Uint8Array(1024*1024);this.used=0;}
  append(bytes) {
    const at=this.offset+this.used;
    if(bytes.length>this.buffer.length) {this.flush();this.write(bytes,this.offset);this.offset+=bytes.length;}
    else {if(this.used+bytes.length>this.buffer.length)this.flush();this.buffer.set(bytes,this.used);this.used+=bytes.length;}
    return at;
  }
  write(bytes,at) {let n=0;while(n<bytes.length) {const wrote=this.handle.write(bytes.subarray(n),{at:at+n});if(!wrote)throw Error('磁碟寫入失敗');n+=wrote;}}
  flush() {if(this.used){this.write(this.buffer.subarray(0,this.used),this.offset);this.offset+=this.used;this.used=0;}}
}
function writeRecord(v,o,r) {
  v.setFloat64(o,r.ts,true); v.setFloat64(o+8,r.dur,true); v.setFloat64(o+16,r.offset,true);
  v.setUint32(o+24,r.length,true);v.setUint32(o+28,r.name,true);v.setFloat64(o+32,r.endOffset||0,true);
  v.setUint32(o+40,r.endLength||0,true);v.setUint32(o+44,r.depth||0,true);
  v.setUint32(o+48,r.color,true);v.setUint32(o+52,r.kind,true);v.setFloat64(o+56,r.value||0,true);
}
function readRecord(v,o) {return {ts:v.getFloat64(o,true),dur:v.getFloat64(o+8,true),offset:v.getFloat64(o+16,true),length:v.getUint32(o+24,true),name:v.getUint32(o+28,true),endOffset:v.getFloat64(o+32,true),endLength:v.getUint32(o+40,true),depth:v.getUint32(o+44,true),color:v.getUint32(o+48,true),kind:v.getUint32(o+52,true),value:v.getFloat64(o+56,true)};}
function counterEnvelope(){return {first:null,last:null,min:null,max:null,count:0};}
const counterOrder=(a,b)=>a.ts-b.ts||a.offset-b.offset;
function counterAdd(bucket,record){
  if(!bucket.first||counterOrder(record,bucket.first)<0)bucket.first=record;
  if(!bucket.last||counterOrder(record,bucket.last)>0)bucket.last=record;
  if(!bucket.min||record.value<bucket.min.value)bucket.min=record;
  if(!bucket.max||record.value>bucket.max.value)bucket.max=record;
  bucket.count++;
}
function counterAddCopy(bucket,record){
  if(!bucket.first||counterOrder(record,bucket.first)<0)bucket.first={...record};
  if(!bucket.last||counterOrder(record,bucket.last)>0)bucket.last={...record};
  if(!bucket.min||record.value<bucket.min.value)bucket.min={...record};
  if(!bucket.max||record.value>bucket.max.value)bucket.max={...record};
  bucket.count++;
}
function counterCopy(target,view,at,ts,value,offset){
  target??={ts:0,value:0,offset:0,length:0,name:0,color:0,dur:0,kind:2,depth:0};
  target.ts=ts;target.value=value;target.offset=offset;target.length=view.getUint32(at+24,true);target.name=view.getUint32(at+28,true);target.color=view.getUint32(at+48,true);return target;
}
function counterAddRaw(bucket,view,at,ts){
  const value=view.getFloat64(at+56,true),offset=view.getFloat64(at+16,true);
  if(!bucket.first||ts<bucket.first.ts||ts===bucket.first.ts&&offset<bucket.first.offset)bucket.first=counterCopy(bucket.first,view,at,ts,value,offset);
  if(!bucket.last||ts>bucket.last.ts||ts===bucket.last.ts&&offset>bucket.last.offset)bucket.last=counterCopy(bucket.last,view,at,ts,value,offset);
  if(!bucket.min||value<bucket.min.value)bucket.min=counterCopy(bucket.min,view,at,ts,value,offset);
  if(!bucket.max||value>bucket.max.value)bucket.max=counterCopy(bucket.max,view,at,ts,value,offset);
  bucket.count++;
}
function counterPoints(bucket){return [...new Map([bucket.first,bucket.last,bucket.min,bucket.max].filter(Boolean).map(r=>[r.offset,r])).values()].sort((a,b)=>a.ts-b.ts||a.offset-b.offset);}
const packCounter=r=>[r.ts,r.value,r.offset,r.length,r.name,r.color];
const unpackCounter=p=>({ts:p[0],value:p[1],offset:p[2],length:p[3],name:p[4],color:p[5],dur:0,kind:2,depth:0});

export class TraceIndex {
  constructor(rawHandle,indexHandle) {
    this.raw=new BufferedFile(rawHandle); this.index=new BufferedFile(indexHandle);
    this.tracks=[];this.trackMap=new Map();this.names=['Event'];this.nameMap=new Map();this.fallbackNames=new Map();this.processes={};
    this.blocks=[];this.buffered=0;this.openSpans=0;this.metadata={};this.phases={};this.start=Infinity;this.end=-Infinity;
    this.count=0;this.slices=0;this.skipped=0;this.unmatched=0;this.outOfOrder=0;this.top=[];
    this.categories=new Map();this.cache=new Map();this.nameLimit=0;this.metadataBytes=0;
    this.legacyNames=false;this.labelCache=new Map();
  }
  intern(name,identity) {name=String(name||'Event').slice(0,160);const key=identity??name;let id=this.nameMap.get(key);if(id!==undefined)return id;
    if(this.names.length>=LIMITS.maxNames){this.nameLimit++;return 0;}
    id=this.names.length;this.names.push(name);this.nameMap.set(key,id);return id;}
  eventName(e,t,suffix=null){
    if(e.name!==null&&e.name!==undefined&&String(e.name).trim())return this.intern(suffix===null?e.name:`${e.name} · ${suffix}`);
    const key=`${t.id}/${suffix===null?'event':`counter:${suffix}`}`;let fallback=this.fallbackNames.get(key);
    if(!fallback){fallback={id:this.intern('未命名事件',Symbol()),trackId:t.id,suffix};this.fallbackNames.set(key,fallback);}
    return fallback.id;
  }
  track(e,suffix='',kind='slice') {
    const key=`${e.pid??0}/${e.tid??0}/${suffix}`;
    let t=this.trackMap.get(key);if(t)return t;
    if(this.tracks.length>=LIMITS.maxTracks)throw Error('超過 8,192 條軌道上限');
    t={id:this.tracks.length,key,pid:e.pid??0,tid:e.tid??0,name:suffix||`Thread ${e.tid??0}`,kind,count:0,duration:0,blocks:[],buffer:[],stack:[],lastTs:-Infinity};
    this.tracks.push(t);this.trackMap.set(key,t);return t;
  }
  addMetadata(key,value) {
    const bytes=JSON.stringify(value).length;
    if(this.metadataBytes+bytes<=4*1024*1024){this.metadata[key]=value;this.metadataBytes+=bytes;}
    else this.skipped++;
  }
  ingest(e,text) {
    if(!e || typeof e!=='object' || Array.isArray(e))throw Error('事件必須是 JSON 物件');
    this.count++;const phase=String(e.ph||'?');this.phases[phase]=(this.phases[phase]||0)+1;
    const bytes=encoder.encode(text);const offset=this.raw.append(bytes),length=bytes.length;
    if(phase==='M') {
      if(e.name==='process_name')this.processes[e.pid??0]=String(e.args?.name??'');
      else if(e.name==='thread_name')this.track(e).name=String(e.args?.name??`Thread ${e.tid}`);
      else if(this.count<10000)this.addMetadata(`${e.name} [${e.pid}:${e.tid}]`,e.args??{});
      return;
    }
    if(!Number.isFinite(e.ts)) {this.skipped++;return;}
    const t=this.track(e);const ts=e.ts;
    if(ts<t.lastTs)this.outOfOrder++;t.lastTs=ts;
    this.start=Math.min(this.start,ts);this.end=Math.max(this.end,ts);
    const category=String(e.cat||'uncategorized');
    if(this.categories.size<1024 || this.categories.has(category))this.categories.set(category,(this.categories.get(category)||0)+1);
    const r={ts,dur:phase==='X'&&Number.isFinite(e.dur)&&e.dur>=0?e.dur:0,offset,length,name:this.eventName(e,t),color:hash(category),kind:0,depth:0};
    if(phase!=='C')this.onEvent?.(e,{...r,trackId:t.id});
    if(phase==='B') {
      if(this.openSpans>=LIMITS.maxOpenSpans)throw Error('未結束的 B 事件超過 100,000 筆');
      r.depth=t.stack.length;t.stack.push(r);this.openSpans++;return;
    }
    if(phase==='E') {
      const begin=t.stack.pop();if(!begin){this.unmatched++;return;}this.openSpans--;
      if(ts<begin.ts){this.unmatched++;return;}
      begin.dur=ts-begin.ts;begin.endOffset=offset;begin.endLength=length;this.add(t,begin);return;
    }
    if(phase==='X') {
      if(!Number.isFinite(e.dur)||e.dur<0){this.skipped++;return;}
      r.dur=e.dur;this.add(t,r);
    } else if(phase==='i'||phase==='I'||phase==='R') {r.kind=1;this.add(t,r);}
    else if(phase==='C') {
      let linked=false;
      for(const [key,value] of Object.entries(e.args||{}))if(Number.isFinite(value)){
        const ct=this.track(e,`${String(e.name??'').trim()||'未命名事件'} · ${key}`,'counter');const name=this.eventName(e,t,key);
        ct.counterSource=String(e.name??'');ct.counterKey=key;
        if(!String(e.name??'').trim())ct.fallbackName=name;
        if(!linked){this.onEvent?.(e,{...r,name,trackId:ct.id,kind:2,value});linked=true;}
        this.add(ct,{...r,name,kind:2,value});
      }
    } else {r.kind=3;this.add(t,r);}
  }
  add(t,r) {
    t.buffer.push(r);this.buffered++;t.count++;t.duration+=r.dur;this.slices++;
    this.end=Math.max(this.end,r.ts+r.dur);
    if(r.dur>0 && (this.top.length<20 || r.dur>this.top[this.top.length-1].dur)){this.top.push({...r,trackId:t.id});this.top.sort((a,b)=>b.dur-a.dur);if(this.top.length>20)this.top.length=20;}
    if(t.buffer.length>=BLOCK)this.flushTrack(t);
    if(this.buffered>=MAX_BUFFER){let largest=this.tracks[0];for(const x of this.tracks)if(x.buffer.length>largest.buffer.length)largest=x;this.flushTrack(largest);}
  }
  flushTrack(t) {
    if(!t.buffer.length)return;
    const rows=t.buffer.sort((a,b)=>a.ts-b.ts || b.dur-a.dur);
    const data=new Uint8Array(rows.length*RECORD),v=new DataView(data.buffer);
    let end=-Infinity;
    rows.forEach((r,i)=>{writeRecord(v,i*RECORD,r);end=Math.max(end,r.ts+r.dur);});
    const start=rows[0].ts,last=rows[rows.length-1].ts;
    const summary=new Map(),counters=t.kind==='counter'?new Map():null;
    for(let i=0;i<rows.length;i++){
      const r=rows[i],bin=Math.min(31,Math.floor((r.ts-start)/Math.max(1,last-start)*32));
      const prior=summary.get(bin);
      if(!prior)summary.set(bin,{...r,n:1});
      else {const n=prior.n+1;if(r.dur>prior.dur)summary.set(bin,{...r,n});else prior.n=n;}
      if(counters){if(!counters.has(bin))counters.set(bin,{...counterEnvelope(),from:i,to:i});const bucket=counters.get(bin);bucket.to=i;counterAdd(bucket,r);}
    }
    const block={at:this.index.append(data),count:rows.length,start,last,end,summary:[...summary.values()]};
    // At most 32 buckets x 4 compact tuples; full records stay on disk.
    if(counters)block.counterSummary=[...counters.values()].map(bucket=>[bucket.from,bucket.to,counterPoints(bucket).map(packCounter)]);
    t.blocks.push(this.blocks.length);this.blocks.push(block);this.buffered-=rows.length;t.buffer=[];
  }
  finish() {
    // Resolve after all metadata, including thread_name at the end of a file.
    for(const {id,trackId,suffix}of this.fallbackNames.values())if(id!==0){const t=this.tracks[trackId],name=fallbackEventName({},t,this.processes);this.names[id]=`${name}${suffix===null?'':` · ${suffix}`}`.slice(0,160);}
    for(const t of this.tracks)if(t.fallbackName!==undefined){t.name=this.names[t.fallbackName];delete t.fallbackName;}
    this.fallbackNames.clear();
    for(const t of this.tracks){this.unmatched+=t.stack.length;t.stack=[];this.flushTrack(t);}
    this.raw.flush();this.index.flush();
    this.raw.handle.flush?.();this.index.handle.flush?.();
    if(!Number.isFinite(this.start)){this.start=0;this.end=1;}
    if(this.end<=this.start)this.end=this.start+1;
    this.adjustPointEnd();
    this.nameMap.clear();this.trackMap.clear();return this.manifest();
  }
  manifest() {
    return {version:1,namePolicy:'short-tid-v1',counterSummaryVersion:1,start:this.start,end:this.end,count:this.count,slices:this.slices,phases:this.phases,
      tracks:this.tracks.map(({buffer,stack,lastTs,...t})=>t),blocks:this.blocks,names:this.names,
      processes:this.processes,metadata:this.metadata,categories:[...this.categories],top:this.top,
      skipped:this.skipped,unmatched:this.unmatched,outOfOrder:this.outOfOrder,nameLimit:this.nameLimit,
      diskBytes:this.raw.offset+this.index.offset};
  }
  adjustPointEnd(){if(this.blocks.some(block=>block.last>=this.end))this.end+=Math.max(.001,Math.abs(this.end)*Number.EPSILON);}
  restore(m) {Object.assign(this,m);this.categories=new Map(m.categories);this.legacyNames=m.namePolicy!=='short-tid-v1';this.adjustPointEnd();m.end=this.end;return this;}
  legacyNameCandidate(name,track){const label=this.names[name];return this.legacyNames&&(!label||label==='Event'||label==='未命名事件'||label===String(track.tid)||label===track.name||track.kind==='counter');}
  displayName(record,trackId=record.trackId,knownEvent){
    const track=this.tracks[trackId]||{},label=this.names[record.name]||record.label||fallbackEventName({},track,this.processes);
    if(record.name===0)return fallbackEventName({},track,this.processes);
    if(!this.legacyNameCandidate(record.name,track))return label;
    const shared=label==='Event'||/^(?:undefined|null|未命名事件)?\s*·/.test(label),key=shared?`${trackId}/${record.offset}`:`${trackId}/name:${record.name}`;
    if(this.labelCache.has(key))return this.labelCache.get(key);
    const event=knownEvent??this.detail(record).event;
    let result=label;
    if(missingEventName(event)){
      result=fallbackEventName(event,track,this.processes);
      if(track.kind==='counter'){const suffix=Object.keys(event.args||{}).filter(key=>Number.isFinite(event.args[key])&&(track.name.endsWith(' · '+key)||track.key?.endsWith(' · '+key))).sort((a,b)=>b.length-a.length)[0];if(suffix!==undefined)result+=' · '+suffix;}
    }
    this.labelCache.set(key,result);if(this.labelCache.size>4096)this.labelCache.delete(this.labelCache.keys().next().value);return result;
  }
  readBlock(b) {
    if(this.cache.has(b.at))return this.cache.get(b.at);
    const data=new Uint8Array(b.count*RECORD);let n=0;
    while(n<data.length){const got=this.index.handle.read(data.subarray(n),{at:b.at+n});if(!got)throw Error('索引讀取不完整');n+=got;}
    const view=new DataView(data.buffer);this.cache.set(b.at,view);
    if(this.cache.size>24)this.cache.delete(this.cache.keys().next().value);return view;
  }
  query({start,end,trackIds,width=1000}) {
    const result=[];const pixel=Math.max(0.001,(end-start)/width);
    for(const id of trackIds){const t=this.tracks[id];if(!t)continue;
      if(t.kind==='counter'){result.push({id,...this.queryCounter(t,start,end,width)});continue;}
      const bins=new Map();
      for(const bi of t.blocks){const b=this.blocks[bi];if(b.start>end||b.end<start)continue;
        let rows;
        if((b.last-b.start)/pixel<24)rows=b.summary;
        else {
          rows=[];const v=this.readBlock(b);
          for(let i=0;i<b.count;i++){const ts=v.getFloat64(i*RECORD,true);if(ts>end)break;
            const dur=v.getFloat64(i*RECORD+8,true);if(ts+dur>=start)rows.push(readRecord(v,i*RECORD));}
        }
        for(const r of rows){if(r.ts>end||r.ts+r.dur<start)continue;
          // Resolution-dependent aggregation: always bound messages and canvas work.
          const scaleLane=r.dur>pixel*2?Math.min(7,1+Math.floor(Math.log2(r.dur/pixel))):0;
          const key=`${Math.floor((Math.max(start,r.ts)-start)/pixel)}:${r.ts<start?'overlap:':''}${Math.min(7,(r.depth||0)+scaleLane)}`;
          const old=bins.get(key),n=(old?.n||0)+(r.n||1);
          if(!old||r.dur>old.dur)bins.set(key,{...r,n});else old.n=n;
        }
      }
      const rows=[...bins.values()].sort((a,b)=>a.ts-b.ts||b.dur-a.dur);
      // Assign lanes to nested or overlapping complete events in the viewport.
      const lanes=[];for(const r of rows){let lane=lanes.findIndex(end=>end<=r.ts);if(lane<0)lane=Math.min(7,lanes.length);
        if(r.dur>0){r.lane=Math.min(7,lane);lanes[lane]=r.ts+r.dur;}else r.lane=0;
        r.label=this.displayName(r,id);r.trackId=id;}
      result.push({id,rows});
    }
    return result;
  }
  queryCounter(track,start,end,width){
    const pixel=Math.max(.001,(end-start)/Math.max(1,width)),bins=new Map();let before,after,beforeBlock,afterBlock;
    const bin=ts=>{const key=Math.floor((ts-start)/pixel);if(!bins.has(key))bins.set(key,counterEnvelope());return bins.get(key);};
    const context=(record)=>{if(record.ts<start&&(!before||record.ts>before.ts||record.ts===before.ts&&record.offset>before.offset))before=record;if(record.ts>end&&(!after||record.ts<after.ts||record.ts===after.ts&&record.offset<after.offset))after=record;};
    const add=(record,coarse=false)=>{
      if(record.ts<start||record.ts>end)return;
      const bucket=bin(record.ts);counterAddCopy(bucket,record);if(coarse)bucket.coarse=true;
    };
    for(const bi of track.blocks){const block=this.blocks[bi];if(block.last<start){if(!beforeBlock||block.last>beforeBlock.last||block.last===beforeBlock.last&&block.at>beforeBlock.at)beforeBlock=block;continue;}if(block.start>end){if(!afterBlock||block.start<afterBlock.start||block.start===afterBlock.start&&block.at<afterBlock.at)afterBlock=block;continue;}let view;
      const raw=(from,to)=>{view??=this.readBlock(block);for(let i=from;i<=to;i++){const at=i*RECORD,ts=view.getFloat64(at,true);if(ts<start)context(readRecord(view,at));else if(ts>end){context(readRecord(view,at));break;}else counterAddRaw(bin(ts),view,at,ts);}};
      if(!block.counterSummary){raw(0,block.count-1);continue;}
      for(const [from,to,points]of block.counterSummary){
        const left=points[0][0],right=points.at(-1)[0];if(left>end){context(unpackCounter(points[0]));continue;}if(right<start){context(unpackCounter(points.at(-1)));continue;}
        // Partially visible buckets are read exactly, so an offscreen extreme
        // cannot hide a smaller but visible spike. Finer zoom also uses disk.
        if(left>=start&&right<=end&&right-left<=pixel){for(const point of points)add(unpackCounter(point),points.length<to-from+1);}
        else raw(from,to);
      }
    }
    if(beforeBlock)context(beforeBlock.counterSummary?unpackCounter(beforeBlock.counterSummary.at(-1)[2].at(-1)):readRecord(this.readBlock(beforeBlock),(beforeBlock.count-1)*RECORD));
    if(afterBlock)context(afterBlock.counterSummary?unpackCounter(afterBlock.counterSummary[0][2][0]):readRecord(this.readBlock(afterBlock),0));
    const label=record=>record?{...record,label:this.displayName(record,track.id),trackId:track.id,lane:0}:null;
    return {rows:[...bins.values()].flatMap(bucket=>counterPoints(bucket).map(record=>({...label(record),n:bucket.coarse?1:bucket.count,aggregated:!!bucket.coarse||bucket.count>4}))).sort((a,b)=>a.ts-b.ts||a.offset-b.offset),before:label(before),after:label(after)};
  }
  resolveRecord(record,phase){
    if(!['B','E','C'].includes(phase)||phase==='B'&&record.endLength||phase==='C'&&record.kind===2)return record;
    const track=this.tracks[record.trackId];if(!track)return record;
    // Relation files store raw endpoints without paired-span/counter fields.
    // Resolve against the existing index; no reparsing or whole-file offset map.
    for(const bi of track.blocks){const block=this.blocks[bi];
      if(block.start>record.ts||block.end<record.ts||phase!=='E'&&block.last<record.ts)continue;
      const view=this.readBlock(block);for(let i=0;i<block.count;i++){const at=i*RECORD;
        if(phase==='E'?view.getUint32(at+40,true)>0&&view.getFloat64(at+32,true)===record.offset:view.getFloat64(at+16,true)===record.offset)return {...readRecord(view,at),trackId:track.id};
      }
    }
    return record;
  }
  detail(r) {
    this.raw.flush();const read=(at,length)=>{
      const bytes=new Uint8Array(length);let n=0;while(n<length){const got=this.raw.handle.read(bytes.subarray(n),{at:at+n});if(!got)throw Error('事件讀取失敗');n+=got;}return decoder.decode(bytes);};
    const rawText=read(r.offset,r.length);return {event:JSON.parse(rawText),rawText,endEvent:r.endLength?JSON.parse(read(r.endOffset,r.endLength)):null};
  }
  async search(term,limit=100,progress=()=>{}) {
    const needle=term.toLocaleLowerCase();const ids=new Set();
    this.names.forEach((name,i)=>{if(name.toLocaleLowerCase().includes(needle))ids.add(i);});
    const results=[];let scanned=0;
    for(const t of this.tracks){for(const bi of t.blocks){const b=this.blocks[bi],v=this.readBlock(b);
      const identityMatches=this.legacyNames&&fallbackEventName({},t,this.processes).toLocaleLowerCase().includes(needle);
      for(let i=0;i<b.count;i++){const r=readRecord(v,i*RECORD);if(ids.has(r.name)||identityMatches){const label=this.displayName(r,t.id);if(!label.toLocaleLowerCase().includes(needle))continue;results.push({...r,label,trackId:t.id});if(results.length>=limit)return {results,capped:true};}}
      scanned+=b.count;if(scanned%32768<4096){progress(scanned);await new Promise(r=>setTimeout(r,0));}
    }}
    return {results,capped:false};
  }
  neighbor(record,direction){
    const t=this.tracks[record.trackId];let best;
    for(const bi of t.blocks){const b=this.blocks[bi];if(direction>0&&b.last<record.ts||direction<0&&b.start>record.ts)continue;
      const v=this.readBlock(b);for(let i=0;i<b.count;i++){const ts=v.getFloat64(i*RECORD,true),offset=v.getFloat64(i*RECORD+16,true);
        if((ts-record.ts||offset-record.offset)*direction<=0)continue;
        if(!best||(ts-best.ts||offset-best.offset)*direction<0){best={...readRecord(v,i*RECORD),trackId:t.id};best.label=this.displayName(best,t.id);}
      }
    }return best;
  }
}

export function demoTrace() {
  const events=[],pid=4128;
  const threads=['CrRendererMain','Compositor','RasterWorker #1','RasterWorker #2','Chrome_IOThread','NetworkService','GPU main'];
  events.push({ph:'M',pid,name:'process_name',args:{name:'shop.example / checkout'}});
  threads.forEach((name,i)=>events.push({ph:'M',pid,tid:i+1,name:'thread_name',args:{name}}));
  let seed=318;const random=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296;};
  const names=[['RunTask','v8','FunctionCall','UpdateLayoutTree','Layout','Paint'],['BeginFrame','CompositeLayers','Commit','ActivateLayerTree'],['RasterTask','DecodeImage'],['RasterTask','ImageDecodeTask'],['IPC::Channel','MojoHandleWatcher'],['ResourceSendRequest','ResourceReceiveResponse','URLRequest'],['DrawFrame','GPUTask','SwapBuffers']];
  for(let tid=1;tid<=7;tid++)for(let frame=0;frame<300;frame++){
    const base=frame*16667+random()*3000,dur=1500+random()*(tid===1?10500:7500);
    events.push({name:names[tid-1][frame%names[tid-1].length],ph:'X',pid,tid,ts:base,dur,cat:tid===1?'devtools.timeline':tid===6?'netlog':tid===7?'gpu':'cc',args:{frame,source:tid===1?'https://shop.example/assets/checkout.js:128:16':'browser',requestId:`req-${frame}`,priority:frame%3?'normal':'high',...(frame===127&&[1,5,6].includes(tid)?{address:'0x7ffe1010'}:{}),details:{component:'CheckoutPage',cached:frame%4!==0}}});
    if(tid===1){events.push({name:'EvaluateScript',ph:'X',pid,tid,ts:base+150,dur:dur*.68,cat:'v8',args:{url:'https://shop.example/assets/checkout.js',lineNumber:128,columnNumber:16}});
      events.push({name:frame%3?'performWorkUntilDeadline':'reconcileChildren',ph:'X',pid,tid,ts:base+250,dur:dur*.35,cat:'v8',args:{functionName:'performWorkUntilDeadline',stack:['CheckoutPage','renderWithHooks','performWorkUntilDeadline']}});}
    if(frame%3===0 && tid===7)events.push({name:'GPU memory',ph:'C',pid,tid,ts:base,args:{MB:140+Math.sin(frame/13)*25+random()*9}});
  }
  events.push({name:'Checkout interaction',ph:'X',pid,tid:1,ts:2118000,dur:184600,cat:'interaction',args:{type:'click',target:'button[data-action="place-order"]',interactionId:7842,address:'0x00007FFE1010',url:'https://shop.example/checkout',paymentProvider:'sandbox',timing:{inputDelay:12.4,processing:148.1,presentation:24.1},stack:['submitOrder','validateCart','createPaymentIntent']}});
  events.push({name:'Order submitted',ph:'i',pid,tid:1,ts:2302600,s:'t',cat:'user_timing',args:{orderId:'DEMO-1042'}});
  events.sort((a,b)=>(a.ts??-1)-(b.ts??-1));
  return {traceEvents:events,displayTimeUnit:'ms',metadata:{description:'Synthetic checkout performance trace. No real customer data.',browser:'Chrome / demo',capture:'2026-10-29',device:'Desktop'}};
}
