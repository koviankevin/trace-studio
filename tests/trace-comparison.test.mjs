import test from 'node:test';import assert from 'node:assert/strict';
import {TraceIndex} from '../dist/core.js';import {compareTraces} from '../dist/trace-comparison.js';import {comparisonHTML} from '../dist/comparison-view.js';
import {parseTfliteSelection} from '../dist/trace-selection.js';
class MemoryFile{data=new Uint8Array(0);write(bytes,{at}){if(this.data.length<at+bytes.length){const next=new Uint8Array(Math.max(at+bytes.length,this.data.length*2,4096));next.set(this.data);this.data=next;}this.data.set(bytes,at);return bytes.length;}read(bytes,{at}){const n=Math.max(0,Math.min(bytes.length,this.data.length-at));bytes.set(this.data.subarray(at,at+n));return n;}flush(){}}
function trace(start,dur){const db=new TraceIndex(new MemoryFile(),new MemoryFile());for(const event of [{name:'compute',ph:'X',pid:1,tid:1,ts:start,dur,args:{TfliteID:7,CoreId:0}},{name:'compute',ph:'X',pid:1,tid:2,ts:start+5,dur,args:{TfliteID:7,CoreId:1}},{name:'other',ph:'X',pid:1,tid:1,ts:start+100,dur:50,args:{TfliteID:8}}])db.ingest(event,JSON.stringify(event));db.finish();return db;}
test('comparison aligns matching IDs, aggregates all same-name events, and releases every opened source',async()=>{
  const traces={a:trace(1000,10),b:trace(9000,20)},released=[];
  const result=await compareTraces(['a','b'],'007',{openTrace:async id=>({trace:traces[id],source:{name:id},release:async()=>released.push(id)})});
  assert.deepEqual(result.traces.map(trace=>[trace.matched,trace.first,trace.spanUs,trace.totalUs]),[[2,1000,15,20],[2,9000,25,40]]);assert.equal(result.traces[1].byName[0].totalUs,40);assert.deepEqual(released,['a','b']);
  const empty=await compareTraces(['a','b'],'99',{openTrace:async id=>({trace:traces[id],source:{name:id},release:async()=>{}})});assert(empty.traces.every(trace=>trace.matched===0&&trace.first===null));
  const broken=await compareTraces(['a','missing'],'7',{openTrace:async id=>{if(!traces[id])throw Error('busy');return {trace:traces[id],source:{name:'<script>'},release:async()=>{}};}});assert.equal(broken.traces[1].status,'error');
  const esc=value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;'),html=comparisonHTML(broken,{esc,time:String,bytes:String,number:String});assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));
  await assert.rejects(compareTraces(['a','b'],'7',{cancelled:()=>true,openTrace:async()=>assert.fail('must not open')}),{name:'AbortError'});
});

test('graph comparisons support three optimization variants, per-operator deltas and independent clipped ranges',async()=>{
  const traces={a:trace(1000,10),b:trace(9000,20),c:trace(20000,5)},openTrace=async id=>({trace:traces[id],source:{name:id},release:async()=>{}});
  const graph=await compareTraces(['a','b','c'],'',{openTrace});assert.equal(graph.mode,'graph');assert.deepEqual(graph.traces.map(trace=>[trace.matched,trace.spanUs,trace.totalUs]),[[3,150,70],[3,150,90],[3,150,60]]);assert.deepEqual(graph.traces.map(trace=>trace.tfliteGroups.find(group=>group.id==='7').totalUs),[20,40,10]);
  await assert.rejects(compareTraces(['a','b','c','d'],'',{openTrace}),/2–3/);
  const scoped=await compareTraces(['a','b'],'',{openTrace,scopes:{a:{start:1005,end:1008},b:{start:9005,end:9008}}});assert.deepEqual(scoped.traces.map(trace=>[trace.matched,trace.spanUs,trace.totalUs]),[[2,3,6],[2,3,6]]);assert(scoped.traces.every(trace=>trace.tfliteGroups.length===1));
  const html=comparisonHTML(scoped,{esc:String,time:String,bytes:String,number:String});assert(html.includes('width:100%'));assert(html.includes('data-compare-id="7"'));assert(!html.includes('data-compare-id="8"'));
  const invalid=await compareTraces(['a','b'],'7',{openTrace,scopes:{a:{start:1008,end:1005}}});assert.equal(invalid.traces[0].status,'error');assert.equal(invalid.traces[1].status,'ok');
});

test('multi-ID selections normalize lists and bounded ranges without double counting shared events',async()=>{
  assert.deepEqual(parseTfliteSelection('007, 8; 10 - 12,0x7'),['7','8','10','11','12']);assert.deepEqual(parseTfliteSelection(''),[]);assert.throws(()=>parseTfliteSelection('8-7'));assert.throws(()=>parseTfliteSelection('0-1000000'));assert.throws(()=>parseTfliteSelection('-1'));
  const sources={a:trace(0,10),b:trace(1000,20)},result=await compareTraces(['a','b'],'7, 8, 7',{openTrace:async id=>({trace:sources[id],source:{name:id},release:async()=>{}})});
  assert.equal(result.mode,'ids');assert.deepEqual(result.tfliteIds,['7','8']);assert.deepEqual(result.traces.map(trace=>trace.totalUs),[70,90]);assert(result.traces.every(trace=>trace.matched===3&&trace.tfliteGroups.length===2));
});
