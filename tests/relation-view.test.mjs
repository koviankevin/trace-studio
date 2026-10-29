import test from 'node:test';import assert from 'node:assert/strict';
import {selectRelationLines} from '../dist/relation-view.js';
const tracks=[{pid:1,name:'CORE0_COMPUTE'},{pid:1,name:'CORE0_DMA'},{pid:2,name:'CORE0_DMA'},{pid:1,name:'CORE1_DMA'}],selected={trackId:0,ts:100,dur:10};
const link=(ts,trackId=1,type='address',role='same',otherRole='same')=>({record:{ts,dur:5,trackId,offset:ts},relation:{type,role},otherRole});
test('compact lines prefer explicit dependencies and two nearest same-process/core address candidates',()=>{
  const before=link(90),after=link(120),flow=link(500,2,'flow'),symbol=link(600,2,'symbol','define','use'),all=[link(0),link(1000),link(99,2),link(99,3),link(99,1,'symbol','use','use'),before,after,flow,symbol];
  const chosen=selectRelationLines(all,selected,tracks);assert.equal(chosen.length,4);assert(chosen.includes(flow)&&chosen.includes(symbol)&&chosen.includes(before)&&chosen.includes(after));assert.equal(all.length,9);assert.equal(selectRelationLines(all,selected,tracks,{mode:'off'}).length,0);assert.equal(selectRelationLines(all,selected,tracks,{mode:'more'}).length,9);
});
test('many strong candidates remain bounded and raw address fanout never exceeds two in compact mode',()=>{
  assert.equal(selectRelationLines(Array.from({length:50},(_,i)=>link(i)),selected,tracks).length,1);assert.equal(selectRelationLines(Array.from({length:50},(_,i)=>link(i)),selected,tracks,{start:80,end:130}).length,0);assert.equal(selectRelationLines(Array.from({length:50},(_,i)=>link(i,1,'flow')),selected,tracks).length,4);assert.equal(selectRelationLines(Array.from({length:50},(_,i)=>link(i)),selected,tracks,{mode:'more'}).length,16);
});
