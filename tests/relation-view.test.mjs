import test from 'node:test';import assert from 'node:assert/strict';
import {selectRelationLines,groupRelationCandidates,relationRecordKey,relationKey,relationEndpoint,isExplicitRelation} from '../dist/relation-view.js';
import {extractRelations} from '../dist/relations.js';
const tracks=[{pid:1,name:'CORE0_COMPUTE'},{pid:1,name:'CORE0_DMA'},{pid:2,name:'CORE0_DMA'},{pid:1,name:'CORE1_DMA'}],selected={trackId:0,ts:100,dur:10,offset:10000};
const link=(ts,trackId=1,type='address',role='same',otherRole='same')=>({record:{ts,dur:5,trackId,offset:ts},relation:{type,key:'0x1000',role},otherRole});
test('nearest other thread draws only the closest existing candidate, regardless of evidence type',()=>{
  const own=link(100,0,'flow'),close=link(111,3),far=link(140,1,'flow');
  assert.deepEqual(selectRelationLines([own,far,close],selected,tracks,{mode:'nearest'}),[close]);
  assert.deepEqual(selectRelationLines([own],selected,tracks,{mode:'nearest'}),[]);
  assert.deepEqual(selectRelationLines([far,close],selected,tracks,{mode:'nearest',start:1000,end:100000,width:10}),[close],'one chosen link survives overview and time boundaries');
});
test('nearest thread identity includes PID, excludes counter metrics of the same thread, and ranks interval gaps',()=>{
  const identity=[{pid:1,tid:7},{pid:1,tid:7},{pid:2,tid:7},{pid:1,tid:8}],sameThread=link(101,1),otherProcess=link(102,2),otherThread=link(103,3);
  assert.deepEqual(selectRelationLines([sameThread,otherThread,otherProcess],selected,identity,{mode:'nearest'}),[otherProcess]);
  const overlap={...link(80,3),record:{...link(80,3).record,dur:30}},separate=link(111,2);
  assert.deepEqual(selectRelationLines([separate,overlap],selected,identity,{mode:'nearest'}),[overlap]);
});
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
  assert.equal(selectRelationLines(all,selected,tracks,{mode:'more',start:100,end:115}).length,2);
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

test('relation candidate groups ignore inherited process names after structured cloning',()=>{
  const tracks=['__proto__','constructor','toString'].map(pid=>({pid,name:'DMA'})),links=tracks.map((_,id)=>link(id,id)),names=structuredClone(JSON.parse('{"__proto__":"CORE0"}')),groups=groupRelationCandidates(links,tracks,names);assert.deepEqual(groups.map(g=>g.label),['CORE0 / 其他軌道','Process constructor / 其他軌道','Process toString / 其他軌道']);
});

test('relation endpoints preserve rendered lanes and mark unqueried offscreen tracks',()=>{
  const record={trackId:1,offset:1,ts:20},layout=[{type:'track',track:{id:1},y:300,h:32}],options={points:new Map(),layout,scrollTop:0,height:100,toX:t=>t*2};
  assert.deepEqual(relationEndpoint(record,options),{x:40,y:92,edge:'below'});
  assert.deepEqual(relationEndpoint(record,{...options,scrollTop:400}),{x:40,y:8,edge:'above'});
  const points=new Map([[relationRecordKey(record),{x:42,y:65}]]);
  assert.deepEqual(relationEndpoint(record,{...options,points}),{x:42,y:65,edge:null});
  points.set(relationRecordKey(record),{x:42,y:-2});
  assert.deepEqual(relationEndpoint(record,{...options,points}),{x:42,y:8,edge:'above'});
  assert.equal(relationEndpoint(record,{...options,layout:[]}),null,'filtered tracks have no invented position');
  assert.equal(relationEndpoint(record,{...options,layout:[{type:'track',track:{id:1},y:20,h:32}]}),null,'visible aggregates are not individual event anchors');
  assert.equal(relationEndpoint(record,{...options,height:0}),null);
});

test('collapsed core anchors retain their real center or an offscreen boundary',()=>{
  const record={trackId:1,offset:1,ts:20},options={points:new Map(),layout:[{type:'group',collapsed:true,trackIds:[1],y:40,h:32}],scrollTop:0,height:100,toX:t=>t};
  assert.deepEqual(relationEndpoint(record,options),{x:20,y:56,edge:null});
  assert.deepEqual(relationEndpoint(record,{...options,scrollTop:100}),{x:20,y:8,edge:'above'});
});

test('panning retains a chosen candidate and compact explicit link beyond either time boundary',()=>{
  const before=link(20,1,'flow'),after=link(200,1,'symbol','define','use'),view={start:80,end:130,width:500};
  assert.deepEqual(selectRelationLines([before],selected,tracks,{...view,focus:relationRecordKey(before.record)}),[before]);
  assert.deepEqual(selectRelationLines([before,after],selected,tracks,{...view,mode:'compact'}),[before,after]);
});

test('offscreen time anchors keep a visible track endpoint and clamp both axes',()=>{
  const record={trackId:1,offset:1,ts:20,dur:5},options={points:new Map(),layout:[{type:'track',track:{id:1},y:40,h:32}],scrollTop:0,height:100,width:500,start:80,end:130,toX:t=>(t-80)*10};
  const left=relationEndpoint(record,options);assert(left,'an unqueried event left of the time window still has a boundary anchor');assert.equal(left.x,8);assert.equal(left.horizontal,'left');assert.equal(left.y,56);
  const right=relationEndpoint({...record,ts:200},options);assert.equal(right.x,492);assert.equal(right.horizontal,'right');
});

test('explicit means trace flow markers or opposite define/use roles, never custom ID equality',()=>{
  assert.deepEqual(extractRelations({ph:'X',args:{LinkId:374,TfliteID:280}}),[]);
  const source=extractRelations({ph:'s',id:7,cat:'pipeline'})[0],target=extractRelations({ph:'f',id:7,cat:'pipeline'})[0];
  assert.equal(source.identity,target.identity);assert(isExplicitRelation({relation:source,otherRole:target.role}));
  const define=extractRelations({ph:'X',args:{defines:'tensorA'}})[0],use=extractRelations({ph:'X',args:{uses:'tensorA'}})[0];assert.equal(define.identity,use.identity);assert(isExplicitRelation({relation:define,otherRole:use.role}));assert(!isExplicitRelation({relation:use,otherRole:'use'}));assert(!isExplicitRelation(link(20)));assert(!isExplicitRelation(link(20,1,'symbol','same','use')));
});
