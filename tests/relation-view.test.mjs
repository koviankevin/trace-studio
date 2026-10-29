import test from 'node:test';import assert from 'node:assert/strict';
import {selectRelationLines,groupRelationCandidates,relationRecordKey,relationKey} from '../dist/relation-view.js';
const tracks=[{pid:1,name:'CORE0_COMPUTE'},{pid:1,name:'CORE0_DMA'},{pid:2,name:'CORE0_DMA'},{pid:1,name:'CORE1_DMA'}],selected={trackId:0,ts:100,dur:10,offset:10000};
const link=(ts,trackId=1,type='address',role='same',otherRole='same')=>({record:{ts,dur:5,trackId,offset:ts},relation:{type,key:'0x1000',role},otherRole});
test('opt-in compact relations draw only two nearest explicit markers, keeping both time directions',()=>{
  const before=link(90,1,'flow'),after=link(120,2,'symbol','define','use'),all=[link(99),link(111),link(98,1,'symbol','use','use'),link(20,1,'flow'),before,after,link(1000,1,'flow')];
  assert.deepEqual(selectRelationLines(all,selected,tracks,{mode:'compact'}),[before,after]);assert.equal(all.length,7);
  assert.deepEqual(selectRelationLines(all.filter(row=>row.relation.type==='address'),selected,tracks),[]);
  assert.equal(selectRelationLines(all,selected,tracks,{mode:'off'}).length,0);
});
test('overview suppresses automatic lines; candidate inspection is explicit and deduplicates endpoints',()=>{
  const address=link(90),duplicate={...address,relation:{...address.relation,key:'0x2000'}},flow=link(120,1,'flow'),all=[address,duplicate,flow];
  assert.deepEqual(selectRelationLines(all,selected,tracks,{mode:'compact',start:0,end:10000,width:100}),[]);
  assert.deepEqual(selectRelationLines(all,selected,tracks,{start:0,end:10000,width:100,focus:relationRecordKey(address.record)}),[address]);
  assert.equal(selectRelationLines(all,selected,tracks,{mode:'more'}).length,2);
  assert.equal(selectRelationLines(all,selected,tracks,{mode:'more',start:100,end:115}).length,0);
  assert.notEqual(relationKey(address),relationKey(duplicate));
});
test('expanded lines stay bounded; groups separate processes and cores without dropping candidates',()=>{
  assert.equal(selectRelationLines(Array.from({length:50},(_,i)=>link(i)),selected,tracks,{mode:'more'}).length,16);
  const all=[link(1),link(2,2),link(3,3),link(4,0)],groups=groupRelationCandidates(all,tracks,{1:'accelerator'});
  assert.deepEqual(groups.map(group=>[group.label,group.links.length,group.trackCount]),[['accelerator / CORE0',2,2],['Process 2 / CORE0',1,1],['accelerator / CORE1',1,1]]);
  assert.equal(groups.flatMap(group=>group.links).length,all.length);
});

test('default manual mode keeps the timeline clear until a single candidate is inspected',()=>{
  const all=[link(90,1,'flow'),link(120,2,'symbol','define','use'),link(99)];
  assert.deepEqual(selectRelationLines(all,selected,tracks),[]);
  assert.deepEqual(selectRelationLines(all,selected,tracks,{focus:relationRecordKey(all[2].record)}),[all[2]]);
  assert.deepEqual(selectRelationLines(all,selected,tracks,{focus:relationRecordKey(all[2].record),mode:'off'}),[]);
});
