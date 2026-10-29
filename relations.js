// Equality links are candidates, never proof of memory ownership or causality.
import {hash} from './core.js?v=0.9.0';
import {fallbackEventName,missingEventName} from './event-labels.js?v=0.4.0';
export function normalizeAddress(value){
  if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)return null;value=String(value);}
  if(typeof value!=='string')return null;
  const s=value.trim();if(!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(s))return null;
  try{return '0x'+BigInt(s).toString(16);}catch{return null;}
}
const addressKey=/(?:^|_)(?:address|addr|ptr|pointer)(?:$|_)/i;
export function extractRelations(event){
  const out=[],seen=new Set();
  const push=(type,value,role,path)=>{const key=type==='address'?normalizeAddress(value):value===null||value===undefined?null:String(value);
    if(key===null||key.length>256||out.length>=32)return;
    const identity=`${type}:${key}`;if(seen.has(identity))return;seen.add(identity);out.push({type,key,identity,role,path});};
  const walk=(obj,path,depth)=>{if(!obj||typeof obj!=='object'||depth>6)return;let count=0;
    for(const [key,value]of Object.entries(obj)){if(++count>256)break;const p=path?`${path}.${key}`:key;
      if(addressKey.test(key)||/^(address|addr|ptr|pointer|baseAddress|srcAddress|dstAddress)$/i.test(key)){
        for(const v of Array.isArray(value)?value:[value])push('address',v,'same',p);
      }else if(/^(defines?|defs|uses?)$/i.test(key)){
        const role=/^(define|def)/i.test(key)?'define':'use';
        for(const v of Array.isArray(value)?value:[value])if(typeof v==='string'||typeof v==='number')push('symbol',v,role,p);
      }else if(typeof value==='string'&&/^0x[0-9a-f]{4,}$/i.test(value))push('address',value,'same',p);
      if(value&&typeof value==='object')walk(value,p,depth+1);
    }
  };
  walk(event.args,'args',0);
  for(const key of ['address','addr','ptr','pointer'])if(event[key]!==undefined)push('address',event[key],'same',key);
  if(['s','t','f'].includes(event.ph)||event.bind_id!==undefined){
    const id=event.bind_id??event.id2?.global??event.id2?.local??event.id;
    if(id!==undefined)push('flow',`${event.cat||''}/${event.scope||''}/${event.id2?.local!==undefined?event.pid:''}/${id}`,event.ph==='s'?'start':event.ph==='f'?'end':'step','id');
  }
  return out;
}
const SIZE=40;
function spanRelations(event,endEvent){const seen=new Set();return [...extractRelations(event),...(endEvent?extractRelations(endEvent):[])].filter(key=>{if(seen.has(key.identity))return false;seen.add(key.identity);return true;});}
// Retain only a bounded set of nearby raw references. The root is the worst.
class NearbyCandidates{
  constructor(limit){this.limit=limit;this.rows=[];this.offsets=new Map();this.omitted=0;}
  compare(a,b){return a.gap-b.gap||a.distance-b.distance||a.record.offset-b.record.offset;}
  swap(a,b){[this.rows[a],this.rows[b]]=[this.rows[b],this.rows[a]];}
  add(candidate){if(this.offsets.has(candidate.record.offset))return;const rows=this.rows;
    if(rows.length<this.limit){rows.push(candidate);this.offsets.set(candidate.record.offset,candidate);let at=rows.length-1;while(at){const parent=(at-1)>>1;if(this.compare(rows[parent],rows[at])>=0)break;this.swap(parent,at);at=parent;}return;}
    this.omitted++;if(this.compare(candidate,rows[0])>=0)return;
    this.offsets.delete(rows[0].record.offset);rows[0]=candidate;this.offsets.set(candidate.record.offset,candidate);let at=0;
    while(true){let child=at*2+1;if(child>=rows.length)break;if(child+1<rows.length&&this.compare(rows[child+1],rows[child])>0)child++;if(this.compare(rows[at],rows[child])>=0)break;this.swap(at,child);at=child;}
  }
  sorted(){return [...this.rows].sort((a,b)=>this.compare(a,b));}
}
const LOOKUP_LIMITS={results:64,indexCandidates:256,rawCandidates:256};
const abortLookup=cancelled=>{if(cancelled()){const error=Error('關聯查找已取消');error.name='AbortError';throw error;}};
export class RelationIndex{
  constructor(handle,trace){this.handle=handle;this.trace=trace;this.offset=0;this.buffers=Array.from({length:64},()=>[]);this.blocks=[];this.count=0;this.buffered=0;this.types={};}
  add(event,ref){for(const relation of extractRelations(event)){
    const h=hash(relation.identity),h2=hash('second:'+relation.identity),bucket=h%64;
    this.buffers[bucket].push({h,h2,...ref});this.buffered++;this.count++;this.types[relation.type]=(this.types[relation.type]||0)+1;
    if(this.buffers[bucket].length>=2048)this.flush(bucket);
    if(this.buffered>=8192){let largest=0;for(let i=1;i<64;i++)if(this.buffers[i].length>this.buffers[largest].length)largest=i;this.flush(largest);}
  }}
  flush(bucket){const rows=this.buffers[bucket];if(!rows.length)return;rows.sort((a,b)=>a.h-b.h||a.h2-b.h2||a.ts-b.ts);
    const bytes=new Uint8Array(rows.length*SIZE),v=new DataView(bytes.buffer);
    rows.forEach((r,i)=>{const o=i*SIZE;v.setUint32(o,r.h,true);v.setUint32(o+4,r.h2,true);v.setFloat64(o+8,r.offset,true);v.setUint32(o+16,r.length,true);v.setUint32(o+20,r.trackId,true);v.setFloat64(o+24,r.ts,true);v.setFloat64(o+32,r.dur,true);});
    let n=0;while(n<bytes.length){const wrote=this.handle.write(bytes.subarray(n),{at:this.offset+n});if(!wrote)throw Error('關聯索引寫入失敗');n+=wrote;}
    this.blocks.push({at:this.offset,count:rows.length,bucket,min:rows[0].h,max:rows[rows.length-1].h});this.offset+=bytes.length;this.buffered-=rows.length;this.buffers[bucket]=[];
  }
  finish(){for(let i=0;i<64;i++)this.flush(i);this.handle.flush?.();return {blocks:this.blocks,count:this.count,bytes:this.offset,types:this.types};}
  restore(m){this.blocks=m.blocks;this.count=m.count;this.offset=m.bytes;this.types=m.types;}
  *_lookup(event,ref,endEvent,{cancelled=()=>false}={}){
    abortLookup(cancelled);if(endEvent===undefined&&ref.endLength)endEvent=this.trace.detail(ref).endEvent;
    const keys=spanRelations(event,endEvent).sort((a,b)=>Number(a.type==='address')-Number(b.type==='address')),matches=[],seen=new Set([ref.offset]),nearby=new NearbyCandidates(LOOKUP_LIMITS.indexCandidates);
    let total=0,scanned=0,rawChecked=0,capped=false,verificationCapped=false;
    const verify=record=>{
      if(seen.has(record.offset))return;
      if(rawChecked>=LOOKUP_LIMITS.rawCandidates){verificationCapped=true;capped=true;return;}rawChecked++;
      let detail=this.trace.detail(record);const resolved=this.trace.resolveRecord(record,detail.event.ph);
      if(resolved!==record){const alias=record.offset;record=resolved;if(seen.has(record.offset)){seen.add(alias);return;}if(alias!==record.offset)seen.add(alias);detail=this.trace.detail(record);}
      const other=detail.event,otherKeys=spanRelations(other,detail.endEvent),associations=keys.flatMap(relation=>{const target=otherKeys.find(candidate=>candidate.identity===relation.identity);return target?[{relation,otherRole:target.role}]:[];});
      if(!associations.length)return;seen.add(record.offset);
      matches.push({record:{...record,label:record.kind===2?this.trace.displayName(record,record.trackId,other):missingEventName(other)?fallbackEventName(other,this.trace.tracks[record.trackId],this.trace.processes):other.name},...associations[0],associations,phase:other.ph});
    };
    for(const key of keys){const h=hash(key.identity),h2=hash('second:'+key.identity);
      for(const b of this.blocks){abortLookup(cancelled);if(b.bucket!==h%64||h<b.min||h>b.max)continue;
        const bytes=new Uint8Array(b.count*SIZE);let n=0;
        while(n<bytes.length){const got=this.handle.read(bytes.subarray(n),{at:b.at+n});if(!got)throw Error('關聯索引讀取失敗');n+=got;}
        const v=new DataView(bytes.buffer);let low=0,high=b.count;
        while(low<high){const mid=(low+high)>>>1;if(v.getUint32(mid*SIZE,true)<h)low=mid+1;else high=mid;}
        for(let i=low;i<b.count&&v.getUint32(i*SIZE,true)===h;i++){
          const o=i*SIZE;if(v.getUint32(o+4,true)!==h2)continue;scanned++;
          const offset=v.getFloat64(o+8,true);if(offset===ref.offset)continue;total++;
          if(!seen.has(offset)){
            const record={offset,length:v.getUint32(o+16,true),trackId:v.getUint32(o+20,true),ts:v.getFloat64(o+24,true),dur:v.getFloat64(o+32,true)};
            if(key.type==='address'){const gap=Math.max(0,ref.ts-(record.ts+record.dur),record.ts-(ref.ts+ref.dur));nearby.add({record,gap,distance:Math.abs(record.ts-ref.ts)});}
            else if(matches.length<LOOKUP_LIMITS.results){verify(record);yield {scanned,rawChecked};abortLookup(cancelled);}else capped=true;
          }
          if(!(scanned%256)){yield {scanned,rawChecked};abortLookup(cancelled);}
        }
        yield {scanned,rawChecked};abortLookup(cancelled);
      }
    }
    for(const candidate of nearby.sorted()){
      abortLookup(cancelled);if(seen.has(candidate.record.offset))continue;if(matches.length>=LOOKUP_LIMITS.results){capped=true;break;}
      verify(candidate.record);yield {scanned,rawChecked};abortLookup(cancelled);if(verificationCapped)break;
    }
    const sampled=nearby.omitted>0||verificationCapped;capped ||=sampled;matches.sort((a,b)=>a.record.ts-b.record.ts);
    return {keys,matches,total:matches.length,indexHits:total,capped,sampled,rawChecked,limits:{...LOOKUP_LIMITS},strategy:'explicit-first-nearby-address'};
  }
  find(event,ref,endEvent){const scan=this._lookup(event,ref,endEvent);let step;do{step=scan.next();}while(!step.done);return step.value;}
  async findAsync(event,ref,endEvent,{cancelled=()=>false,timeBudgetMs=8,yieldNow=()=>new Promise(resolve=>setTimeout(resolve,0)),onProgress=()=>{}}={}){
    if(!Number.isFinite(timeBudgetMs)||timeBudgetMs<0||timeBudgetMs>50)throw Error('關聯查找時間預算無效');
    const scan=this._lookup(event,ref,endEvent,{cancelled});let last=performance.now();
    try{while(true){abortLookup(cancelled);const step=scan.next();if(step.done)return step.value;if(performance.now()-last>=timeBudgetMs){onProgress(step.value);await yieldNow();abortLookup(cancelled);last=performance.now();}}}finally{scan.return();}
  }
}
