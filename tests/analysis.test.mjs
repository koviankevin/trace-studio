import test from 'node:test';
import assert from 'node:assert/strict';
import {TraceIndex} from '../dist/core.js';
import {analyzeTrace,scanTraceIndex} from '../dist/analysis.js';
import {createExtensionHost,loadExtensionHost} from '../dist/extensions/runtime.js';
import {eventColor} from '../dist/event-colors.js';
class MemoryFile{data=new Uint8Array(0);write(b,{at}){if(this.data.length<at+b.length){const next=new Uint8Array(Math.max(at+b.length,this.data.length*2,4096));next.set(this.data);this.data=next;}this.data.set(b,at);return b.length;}read(b,{at}){const n=Math.min(b.length,this.data.length-at);b.set(this.data.subarray(at,at+n));return n;}flush(){}}
function build(events){const trace=new TraceIndex(new MemoryFile(),new MemoryFile());for(const event of events)trace.ingest(event,JSON.stringify(event));trace.finish();return trace;}
const events=[{ph:'X',name:'A',pid:1,tid:1,ts:0,dur:10},{ph:'X',name:'A',pid:1,tid:1,ts:5,dur:20},{ph:'X',name:'B',pid:1,tid:1,ts:50,dur:5},{ph:'i',name:'mark',pid:1,tid:1,ts:15},{ph:'C',name:'memory',pid:1,tid:1,ts:16,args:{MB:100}},{ph:'X',name:'A',pid:1,tid:2,ts:10,dur:5},{ph:'X',name:'B',pid:1,tid:2,ts:30,dur:0}];
test('analysis clips to scope, retains overlap explicitly, and separates counters and markers',async()=>{
  const result=await analyzeTrace(build(events),{start:8,end:20,thresholdUs:5});assert.equal(result.complete,3);assert.equal(result.totalUs,19);assert.equal(result.longEvents,2);assert.equal(result.markers,1);assert.equal(result.counters,1);assert.equal(result.maxUs,12);assert.equal(result.byName[0].count,3);assert.equal(result.byName[0].minUs,2);assert.equal(result.longest[0].record.dur,20);assert.equal(result.longest[0].clippedUs,12);assert(result.notes.some(n=>n.includes('不是 self time')));
});
test('full and track-filtered analysis count zero duration slices and use a half-open time range',async()=>{
  const trace=build(events),full=await analyzeTrace(trace);assert.equal(full.complete,5);assert.equal(full.totalUs,40);assert.equal(full.byName.find(n=>n.label==='B').minUs,0);
  const one=await analyzeTrace(trace,{trackIds:[2,2]});assert.equal(one.complete,2);assert.equal(one.totalUs,5);
  const boundary=await analyzeTrace(trace,{start:0,end:5});assert.equal(boundary.complete,1);assert.equal(boundary.totalUs,5);
});
test('analysis bounds returned names and records, yields, cancels, and never reads raw args',async()=>{
  const trace=build(Array.from({length:40000},(_,i)=>({ph:'X',name:'Task '+i%150,pid:1,tid:1,ts:i,dur:2})));trace.detail=()=>{throw Error('raw args must stay on disk');};let yields=0;
  const result=await analyzeTrace(trace,{yieldNow:async()=>{yields++;}});assert.equal(result.byName.length,100);assert.equal(result.longest.length,50);assert(yields>0);
  let cancel=false;await assert.rejects(analyzeTrace(trace,{cancelled:()=>cancel,yieldNow:async()=>{cancel=true;}}),{name:'AbortError'});
});
test('analysis handles empty scopes and rejects invalid inputs',async()=>{
  const trace=build(events);const result=await analyzeTrace(trace,{trackIds:[]});assert.equal(result.complete,0);assert.equal(result.minUs,0);assert.equal(result.p95UpperUs,0);assert.deepEqual(result.longest,[]);
  await assert.rejects(analyzeTrace(trace,{start:2,end:1}));await assert.rejects(analyzeTrace(trace,{thresholdUs:-1}));
});

test('legacy analysis projects compact TIDs and preserves explicitly named Event records',async()=>{
  const trace=build([{ph:'X',pid:'CORE0',tid:'CORE0_COMPUTE',ts:0,dur:10},{ph:'X',pid:'CORE0',tid:'CORE0_COMPUTE',name:'Event',ts:20,dur:5}]),manifest=trace.manifest();delete manifest.namePolicy;manifest.names=manifest.names.map(()=> 'Event');
  for(const block of manifest.blocks){const data=new DataView(trace.index.handle.data.buffer);for(let i=0;i<block.count;i++)data.setUint32(block.at+i*64+28,1,true);}
  const restored=new TraceIndex(trace.raw.handle,trace.index.handle).restore(manifest),result=await analyzeTrace(restored);
  assert.deepEqual(result.byName.map(row=>[row.label,row.count,row.totalUs]),[['COMPUTE',1,10],['Event',1,5]]);assert.equal(result.longest[0].record.label,'COMPUTE');
});
test('extension index scanning preserves references and can read one selected event',async()=>{
  const trace=build(events),rows=[];for await(const row of scanTraceIndex(trace,{start:8,end:20,trackIds:[0]}))rows.push(row);assert.equal(rows.length,3);assert.equal(trace.detail(rows.find(r=>r.label==='A')).event.name,'A');
});
test('extension host supports fields, colors and analyses while isolating plugin failure and summary edits',async()=>{
  const host=createExtensionHost([{id:'ok',title:'Example',eventFields:e=>[{label:'ID',value:e.args.id}],eventColor:()=>({fill:'#aabbcc',category:'Custom'}),analyze:async({summary})=>{summary.complete=99;return {summary:'sample',rows:[{label:'sample',value:2}]};}},{id:'broken',eventFields(){throw Error('field error');},analyze(){throw Error('analysis error');}}]);
  const fields=host.eventFields({args:{id:12}});assert.equal(fields.fields[0].value,'12');assert.equal(fields.errors[0].message,'field error');assert.equal(host.eventColor({}).fill,'#aabbcc');
  const summary={complete:1},result=await host.analyze({summary,scope:{start:0,end:1}});assert.equal(summary.complete,1);assert.equal(result[0].status,'ok');assert.equal(result[1].status,'error');
  assert.throws(()=>createExtensionHost([{id:'same'},{id:'same'}]));const fallback=await loadExtensionHost(async()=>{throw Error('syntax error');});assert.deepEqual(fallback.list(),[]);assert.equal(fallback.startupErrors.length,1);
});
test('extension cancellation propagates and invalid colors cannot break the default renderer',async()=>{
  const host=createExtensionHost([{id:'a',eventColor:()=>({fill:'url(javascript:x)'}),analyze:()=>({rows:[]})}]);assert.equal(host.eventColor({}),null);await assert.rejects(host.analyze({cancelled:()=>true}),{name:'AbortError'});
});
test('event palette distinguishes compute, transfer, wait and frame and is stable across redraws',()=>{
  const inputs=['CONV','DMA · COMPUTE','Semaphore wait','FRAME'];const result=inputs.map(label=>eventColor({label}));assert.equal(new Set(result.map(x=>x.fill)).size,4);assert.equal(eventColor({label:'CONV'}).fill,result[0].fill);assert.notEqual(eventColor({label:'CONV'},true).fill,result[0].fill);assert.equal(eventColor({label:'CUSTOM_OP'}).category,'其他');
});


test('unindexed names preserve all duration totals, report exclusions, and hydrate at most the longest 50',async()=>{
  const events=Array.from({length:70},(_,i)=>({ph:'X',name:'long'.repeat(1100)+i,pid:1,tid:77,ts:i*200,dur:i+1})),trace=build(events);let reads=0;const detail=trace.detail.bind(trace);trace.detail=record=>{reads++;return detail(record);};
  const result=await analyzeTrace(trace);assert.equal(result.complete,70);assert.equal(result.totalUs,2485);assert.equal(result.tracks[0].totalUs,2485);assert.equal(result.unindexedNameEvents,70);assert.equal(result.unindexedNameUs,2485);assert.deepEqual(result.byName,[]);assert.equal(reads,50);assert(result.longest.every(row=>row.record.label.startsWith('long')));assert(result.notes.some(note=>note.includes('名稱排行不包含')));
  const name='prefix'.repeat(30)+'tail',normal=build([{ph:'X',name,ts:0,dur:1}]),manifest=normal.manifest();delete manifest.fullNamesVersion;manifest.names=manifest.names.map(value=>value.slice(0,160));const legacy=new TraceIndex(normal.raw.handle,normal.index.handle).restore(manifest);
  const old=await analyzeTrace(legacy);assert.equal(old.unindexedNameEvents,1);assert(old.longest[0].record.label.endsWith('tail'));
});
