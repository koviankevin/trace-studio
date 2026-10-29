import test from 'node:test';import assert from 'node:assert/strict';
import {TraceIndex} from '../dist/core.js';import {analyzeArguments} from '../dist/argument-analysis.js';
class MemoryFile{constructor(){this.data=new Uint8Array(0);}write(bytes,{at}){if(this.data.length<at+bytes.length){const next=new Uint8Array(Math.max(at+bytes.length,this.data.length*2,1024));next.set(this.data);this.data=next;}this.data.set(bytes,at);return bytes.length;}read(bytes,{at}){const n=Math.min(bytes.length,this.data.length-at);if(n<=0)return 0;bytes.set(this.data.subarray(at,at+n));return n;}flush(){}}
function trace(events){const db=new TraceIndex(new MemoryFile(),new MemoryFile());events.forEach(event=>db.ingest(event,JSON.stringify(event)));db.finish();return db;}
const mem=(start,size,role)=>({RangeStart:start,Size:size,Space:`LOC_${role}_LOCAL`});
test('argument analysis groups cross-core IDs and matches memory ranges with process context',async()=>{
  const db=trace([{ph:'X',pid:'CORE0',tid:'CORE0_COMPUTE',ts:0,dur:10,args:{TfliteID:7,LinkId:42,CoreId:0,MemoryRanges:mem('0x1000',256,'OUTPUT')}},{ph:'X',pid:'CORE0',tid:'CORE0_DMA',ts:20,dur:5,args:{TfliteID:7,LinkId:42,CoreId:0,MemoryRanges:mem('0x1080',256,'INPUT')}},{ph:'X',pid:'CORE1',tid:'CORE1_COMPUTE',ts:20,dur:10,args:{TfliteID:7,LinkId:42,CoreId:1,MemoryRanges:mem('0x1000',256,'OUTPUT')}}]);
  const result=await analyzeArguments(db,{focus:{kind:'flow',value:'42'}});assert.equal(result.events,3);assert.equal(result.groups.tflite[0].count,3);assert.equal(result.groups.flow[0].totalUs,25);assert.equal(result.matched,3);assert.deepEqual(result.groups.flow[0].cores,['0','1']);
  const memory=await analyzeArguments(db,{focus:{kind:'memory',pid:'CORE0',core:'0',memories:[result.members[0].memories[0]]}});assert.equal(memory.matched,2);assert(memory.members.some(member=>member.matches.some(match=>match.bytes==='128')));
});
test('paired E arguments are included and analysis yields/cancels without unbounded results',async()=>{
  const db=trace([{ph:'B',pid:1,tid:1,ts:0,args:{}},{ph:'E',pid:1,tid:1,ts:100,args:{TfliteID:0,LinkId:0}},...Array.from({length:300},(_,i)=>({ph:'X',pid:1,tid:1,ts:200+i,dur:1,args:{LinkId:i,TfliteID:0}}))]);
  let yields=0;const result=await analyzeArguments(db,{focus:{kind:'tflite',value:'0'},maxGroups:2,timeBudgetMs:0,yieldNow:async()=>{yields++;}});assert.equal(result.events,301);assert.equal(result.matched,301);assert.equal(result.members.length,100);assert(result.hasMore&&result.omittedGroupEvents>0&&yields>0);
  await assert.rejects(analyzeArguments(db,{cancelled:()=>true}),{name:'AbortError'});
});
test('counter metrics count their original event once, including the final sample and filtered metrics',async()=>{
  const db=trace([{ph:'C',pid:1,tid:1,ts:0,args:{watts:1,bytes:2,TfliteID:7}},{ph:'C',pid:1,tid:1,ts:10,args:{watts:3,bytes:4,TfliteID:7}}]);
  assert.equal((await analyzeArguments(db)).events,2);const metric=db.tracks.find(t=>t.counterKey==='bytes');assert.equal((await analyzeArguments(db,{trackIds:[metric.id]})).events,2);
  const variable=trace([{ph:'C',pid:1,tid:1,ts:0,args:{watts:1,bytes:2}},{ph:'C',pid:1,tid:1,ts:10,args:{bytes:4}},{ph:'C',pid:1,tid:1,ts:20,args:{watts:5}}]);assert.equal((await analyzeArguments(variable)).events,3);
});
