import test from 'node:test';
import assert from 'node:assert/strict';
import {TraceJSONReader,TraceIndex,demoTrace,LIMITS} from '../dist/core.js';
import {RelationIndex,extractRelations,normalizeAddress} from '../dist/relations.js';
class MemoryFile{
  constructor(){this.data=new Uint8Array(0);}
  write(bytes,{at}){if(this.data.length<at+bytes.length){const n=new Uint8Array(Math.max(at+bytes.length,this.data.length*2,1024));n.set(this.data);this.data=n;}this.data.set(bytes,at);return bytes.length;}
  read(bytes,{at}){const n=Math.min(bytes.length,this.data.length-at);if(n<=0)return 0;bytes.set(this.data.subarray(at,at+n));return n;}
  flush(){}
}
function parse(text,chunk=13){const events=[],metadata={};const p=new TraceJSONReader((e,raw)=>events.push({e,raw}),(k,v)=>metadata[k]=v);for(let i=0;i<text.length;i+=chunk)p.feed(text.slice(i,i+chunk));p.end();return {events,metadata};}
function build(events){const raw=new MemoryFile(),index=new MemoryFile(),linkFile=new MemoryFile(),db=new TraceIndex(raw,index),links=new RelationIndex(linkFile,db);db.onEvent=(e,r)=>links.add(e,r);for(const e of events)db.ingest(e,JSON.stringify(e));const manifest=db.finish();const linkManifest=links.finish();return {db,links,manifest,linkManifest,raw,index,linkFile};}
test('streams wrapped objects and bare arrays across every possible boundary',()=>{
  const e={name:'中文 🌏 \\"quoted"',ph:'X',pid:1,tid:2,ts:10,dur:20,args:{nested:['a,b} ]',{x:'\\n'}]}};
  for(const text of [JSON.stringify([e,e]),JSON.stringify({meta:{x:1},traceEvents:[e,e],displayTimeUnit:'ns',flag:true,num:12})]){
    for(let size=1;size<=text.length;size++){const r=parse(text,size);assert.deepEqual(r.events.map(x=>x.e),[e,e]);}
  }
});
test('rejects malformed, truncated and trailing JSON, missing or duplicate traceEvents',()=>{
  for(const text of ['[{"name":"x"}', '[{},]','{"traceEvents":[{}],}','[{}]{}','{}','{"traceEvents":{}}','{"traceEvents":[],"traceEvents":[]}','[{"name":"a"},null]','{"x": 01,"traceEvents":[]}'])assert.throws(()=>parse(text));
});
test('supports empty traces and metadata after events',()=>{assert.equal(parse('[]').events.length,0);assert.deepEqual(parse('{"traceEvents":[],"metadata":{"app":"test"}}',1).metadata,{metadata:{app:'test'}});});
test('disk index preserves nested args, UTF-8, custom fields and raw JSON',()=>{
  const event={name:'測試 🌏',ph:'X',pid:7,tid:4,ts:200,dur:80,args:{ptr:'0x00ABC',nested:{list:['a','b']}},custom:42};
  const {db}=build([event]);const r=db.query({start:210,end:220,trackIds:[0],width:1000})[0].rows[0];assert.equal(r.dur,80);assert.deepEqual(db.detail(r).event,event);assert.equal(db.detail(r).rawText,JSON.stringify(event));
});

test('unnamed events use their final thread name without altering raw events or explicit names',async()=>{
  const event={ph:'X',pid:1,tid:2,ts:0,dur:10,args:{address:'0x1'}};
  const {db,manifest,raw,index}=build([event,
    {ph:'X',pid:1,tid:3,ts:20,dur:10,name:'Event'},
    {ph:'B',pid:1,tid:2,ts:40,name:'  '},{ph:'E',pid:1,tid:2,ts:60},
    {ph:'C',pid:1,tid:2,ts:70,args:{load:42}},
    {ph:'M',pid:1,tid:2,name:'thread_name',args:{name:'CORE0_COMPUTE'}}]);
  const rows=db.query({start:0,end:100,trackIds:manifest.tracks.map(t=>t.id),width:1000}).flatMap(t=>t.rows);
  assert.equal(rows.find(r=>r.ts===0).label,'CORE0_COMPUTE');
  assert.equal(rows.find(r=>r.ts===20).label,'Event');
  assert.equal(rows.find(r=>r.ts===40).label,'CORE0_COMPUTE');
  assert.equal(rows.find(r=>r.kind===2).label,'CORE0_COMPUTE · load');
  assert.deepEqual(db.detail(rows.find(r=>r.ts===0)).event,event);
  assert.equal(db.detail(rows.find(r=>r.ts===0)).rawText,JSON.stringify(event));
  const restored=new TraceIndex(raw,index).restore(JSON.parse(JSON.stringify(manifest)));
  assert.equal(restored.query({start:0,end:10,trackIds:[0]})[0].rows[0].label,'CORE0_COMPUTE');
  assert((await restored.search('CORE0_COMPUTE')).results.some(r=>r.ts===0));
  assert.equal(db.neighbor(rows.find(r=>r.ts===0),1).label,'CORE0_COMPUTE');
  const unnamed=build([{ph:'X',ts:0,dur:10,pid:5,tid:123}]);
  assert.equal(unnamed.db.query({start:0,end:10,trackIds:[0]})[0].rows[0].label,'123');
});
test('B/E pairs, incomplete spans, metadata, counters and unsupported phases',()=>{
  const events=[{ph:'M',pid:1,tid:1,name:'thread_name',args:{name:'Main'}},{ph:'B',pid:1,tid:1,ts:100,name:'outer',args:{x:1}},{ph:'B',pid:1,tid:1,ts:110,name:'inner'},{ph:'E',pid:1,tid:1,ts:130,args:{result:'ok'}},{ph:'E',pid:1,tid:1,ts:180},{ph:'E',pid:1,tid:1,ts:181},{ph:'C',pid:1,tid:1,ts:190,name:'memory',args:{MB:100,objects:42}},{ph:'s',pid:1,tid:1,ts:195,name:'flow',id:1},{ph:'B',pid:1,tid:1,ts:199,name:'incomplete'}];
  const {db,manifest}=build(events);assert.equal(manifest.unmatched,2);assert.equal(manifest.tracks[0].name,'Main');assert.equal(manifest.tracks.filter(t=>t.kind==='counter').length,2);
  const rows=db.query({start:0,end:200,trackIds:[0],width:1000})[0].rows;const inner=rows.find(r=>r.label==='inner');assert.equal(inner.dur,20);assert.equal(db.detail(inner).endEvent.args.result,'ok');
});
test('unsorted blocks and long overlaps are queried and adjacent events navigate exactly',()=>{
  const events=Array.from({length:8500},(_,i)=>({ph:'X',pid:1,tid:1,name:`event${i}`,ts:(8500-i)*100,dur:90}));events.push({ph:'X',pid:1,tid:1,name:'long',ts:1,dur:1e6});
  const {db}=build(events),rows=db.query({start:400000,end:401000,trackIds:[0],width:1000})[0].rows;
  assert(rows.some(r=>r.label==='long'));const r=rows.find(r=>r.ts===400000);assert(r);assert.equal(db.neighbor(r,1).ts,400100);assert.equal(db.neighbor(r,-1).ts,399900);
});
test('index restoration produces identical queries and details',()=>{
  const {db,manifest,raw,index,linkManifest,linkFile}=build([{name:'a',ph:'X',ts:1,dur:10,args:{address:'0x1'}},{name:'b',ph:'X',ts:20,dur:10,args:{address:'1'}}]);
  const copy=new TraceIndex(raw,index).restore(JSON.parse(JSON.stringify(manifest)));assert.deepEqual(copy.query({start:0,end:100,trackIds:[0]}),db.query({start:0,end:100,trackIds:[0]}));
  const links=new RelationIndex(linkFile,copy);links.restore(linkManifest);const record=copy.query({start:0,end:100,trackIds:[0]})[0].rows[0];assert.equal(links.find(copy.detail(record).event,record).matches.length,1);
});
test('addresses normalize without unsafe precision and are not guessed from arbitrary numbers',()=>{
  assert.equal(normalizeAddress('0X0000ABCD'),'0xabcd');assert.equal(normalizeAddress('43981'),'0xabcd');assert.equal(normalizeAddress(43981),'0xabcd');assert.equal(normalizeAddress(2**60),null);assert.equal(normalizeAddress('0xnot'),null);
  const relations=extractRelations({args:{address:'0x00Ab',nested:{ptr:171,hex:'0x000abc'},requestId:171}});assert.equal(relations.length,2);assert.equal(relations[0].key,'0xab');
});
test('relation index resolves exact addresses, defs/uses and standard flow IDs across threads',()=>{
  const events=[{name:'Allocate',ph:'X',pid:1,tid:1,ts:1,dur:20,args:{address:'0x000AbC',defines:'result'}},{name:'Read',ph:'X',pid:1,tid:2,ts:40,dur:4,args:{ptr:'2748',uses:['result']}},{name:'Other',ph:'X',pid:1,tid:2,ts:50,dur:4,args:{address:'0xabd'}},{name:'Start',ph:'s',pid:1,tid:1,ts:100,id:5},{name:'End',ph:'f',pid:1,tid:2,ts:200,id:5}];
  const {db,links}=build(events);const record=db.query({start:0,end:10,trackIds:[0],width:1000})[0].rows[0];const result=links.find(events[0],record);assert.equal(result.matches.length,1);assert.equal(result.matches[0].record.label,'Read');assert.equal(result.matches[0].record.dur,4);
  const flow=db.query({start:100,end:100,trackIds:[0]})[0].rows[0];assert.equal(links.find(events[3],flow).matches[0].record.label,'End');
});
test('dense queries are bounded by viewport resolution and event buffers stay bounded',()=>{
  const raw=new MemoryFile(),index=new MemoryFile(),db=new TraceIndex(raw,index);
  for(let i=0;i<50000;i++){const e={ph:'X',name:'task',ts:i,dur:.1,pid:1,tid:i%16};db.ingest(e,JSON.stringify(e));assert(db.buffered<LIMITS.bufferedEvents);}
  db.finish();const rows=db.query({start:0,end:50000,trackIds:[0],width:100})[0].rows;assert(rows.length<=101);assert(rows.reduce((sum,r)=>sum+r.n,0)>=3000);
});
test('demo includes actual linkable addresses and a selected long event',()=>{const {db,links,manifest}=build(demoTrace().traceEvents);const top=manifest.top[0];assert.equal(db.detail(top).event.name,'Checkout interaction');assert.equal(links.find(db.detail(top).event,top).matches.length,3);});
