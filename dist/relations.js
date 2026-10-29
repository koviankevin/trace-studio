// Equality links are candidates, never proof of memory ownership or causality.
import {hash} from './core.js?v=0.7.1';
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
  find(event,ref,endEvent){
    if(endEvent===undefined&&ref.endLength)endEvent=this.trace.detail(ref).endEvent;
    const keys=spanRelations(event,endEvent).sort((a,b)=>Number(a.type==='address')-Number(b.type==='address')),matches=[],seen=new Set();let total=0,capped=false;
    for(const key of keys){const h=hash(key.identity),h2=hash('second:'+key.identity);
      for(const b of this.blocks){if(b.bucket!==h%64||h<b.min||h>b.max)continue;
        const bytes=new Uint8Array(b.count*SIZE);let n=0;
        while(n<bytes.length){const got=this.handle.read(bytes.subarray(n),{at:b.at+n});if(!got)throw Error('關聯索引讀取失敗');n+=got;}
        const v=new DataView(bytes.buffer);let low=0,high=b.count;
        while(low<high){const mid=(low+high)>>>1;if(v.getUint32(mid*SIZE,true)<h)low=mid+1;else high=mid;}
        for(let i=low;i<b.count&&v.getUint32(i*SIZE,true)===h;i++){
          const o=i*SIZE;if(v.getUint32(o+4,true)!==h2)continue;
          const offset=v.getFloat64(o+8,true);if(offset===ref.offset)continue;total++;
          // Bound raw reads and results for frequently reused addresses.
          if(seen.has(offset))continue;if(matches.length>=64){capped=true;continue;}
          let record={offset,length:v.getUint32(o+16,true),trackId:v.getUint32(o+20,true),ts:v.getFloat64(o+24,true),dur:v.getFloat64(o+32,true)};
          let detail=this.trace.detail(record);const resolved=this.trace.resolveRecord(record,detail.event.ph);
          if(resolved!==record){record=resolved;if(record.offset===ref.offset||seen.has(record.offset)){seen.add(offset);continue;}detail=this.trace.detail(record);}
          const other=detail.event,verified=spanRelations(other,detail.endEvent).find(r=>r.identity===key.identity);if(!verified)continue;
          seen.add(offset);seen.add(record.offset);matches.push({record:{...record,label:record.kind===2?this.trace.displayName(record,record.trackId,other):missingEventName(other)?fallbackEventName(other,this.trace.tracks[record.trackId],this.trace.processes):other.name},relation:key,otherRole:verified.role,phase:other.ph});
        }
      }
    }
    matches.sort((a,b)=>a.record.ts-b.record.ts);return {keys,matches,total:matches.length,indexHits:total,capped};
  }
}
