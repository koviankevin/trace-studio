import test from 'node:test';import assert from 'node:assert/strict';
import {TraceIndex} from '../dist/core.js';import {compareTraces} from '../dist/trace-comparison.js';import {comparisonHTML} from '../dist/comparison-view.js';
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
