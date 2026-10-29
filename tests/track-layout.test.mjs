import test from 'node:test';
import assert from 'node:assert/strict';
import {coreName,groupTracks,allGroups,defaultCollapsed,makeTrackLayout,revealTrack,trackHeight,summarizeGroups,trackName} from '../dist/track-layout.js';
import {eventSummary} from '../dist/event-summary.js';
import {hardwareDemo} from '../dist/hardware-demo.js';
function track(id,pid,name){return {id,pid,tid:id+1,name,count:1,kind:'slice'};}
test('recognizes named cores without confusing engine/channel numbers for cores',()=>{
  for(const [name,expected]of [['CORE0_BUFFER_A_0 work','CORE0'],['CORE12_COMPUTE','CORE12'],['CPU #3 thread','CPU3'],['core_02: decode','CORE2'],['BUFFER_A_0',null],['linkid123',null]])assert.equal(coreName(name),expected);
});
test('groups processes and cores, keeps work pairs adjacent and removes redundant prefixes only in labels',()=>{
  const tracks=[track(0,1,'CORE0_COMPUTE work'),track(1,1,'CORE1_COMPUTE'),track(2,1,'CORE0_COMPUTE'),track(3,1,'CORE0_BUFFER_A_10'),track(4,1,'CORE0_BUFFER_A_2'),track(5,2,'CORE0_COMPUTE')];
  const groups=groupTracks(tracks,{1:'Accelerators',2:'CORE0'});assert.equal(groups.length,2);const first=groups.find(g=>g.pid==='1');assert.equal(first.children.length,2);assert.deepEqual(first.children.map(g=>g.label),['CORE0','CORE1']);
  const layout=makeTrackLayout(groups).rows.filter(r=>r.type==='track');const names=layout.filter(r=>r.track.pid===1).map(r=>r.track.name);
  assert.deepEqual(names.slice(0,4),['CORE0_BUFFER_A_2','CORE0_BUFFER_A_10','CORE0_COMPUTE','CORE0_COMPUTE work']);assert.equal(layout.find(r=>r.track.id===0).displayName,'COMPUTE work');assert.equal(tracks[0].name,'CORE0_COMPUTE work');
});
test('collapsed groups expose summaries, filtering reveals matches, and reveal follows only the selected core',()=>{
  const groups=groupTracks([track(0,1,'CORE0_COMPUTE'),track(1,1,'CORE1_COMPUTE'),track(2,1,'CORE1_OUTPUT_STORE')],{1:'Accelerators'}),collapsed=defaultCollapsed(groups);
  const initial=makeTrackLayout(groups,{collapsed});assert.equal(initial.rows.filter(r=>r.type==='track').length,0);assert.equal(initial.rows.filter(r=>r.collapsed).length,2);
  const filtered=makeTrackLayout(groups,{collapsed,filter:'CORE1_OUTPUT_STORE'});assert.deepEqual(filtered.rows.filter(r=>r.type==='track').map(r=>r.track.id),[2]);assert.equal(collapsed.size,2);
  revealTrack(groups,collapsed,2);const revealed=makeTrackLayout(groups,{collapsed});assert.deepEqual(revealed.rows.filter(r=>r.type==='track').map(r=>r.track.id),[1,2]);assert(collapsed.has('core:1:CORE0'));
});
test('pinned tracks remain visible exactly once even when their process is collapsed',()=>{
  const groups=groupTracks([track(0,1,'CORE0_COMPUTE'),track(1,2,'CORE1_COMPUTE')],{1:'same name',2:'same name'});assert.equal(new Set(allGroups(groups).map(g=>g.id)).size,2);
  const rows=makeTrackLayout(groups,{collapsed:defaultCollapsed(groups),pins:new Set([1])}).rows;assert.equal(rows[0].track.id,1);assert.equal(rows.filter(r=>r.type==='track'&&r.track.id===1).length,1);assert.equal(rows.filter(r=>r.type==='group').length,1);
});
test('dense tracks keep 12px event text geometry, add lanes when necessary, and use less vertical space',()=>{
  const t=track(0,1,'CORE0_COMPUTE');assert.equal(trackHeight(t),32);assert.equal(trackHeight(t,{lanes:4}),86);assert.equal(trackHeight(t,{expanded:true}),160);assert.equal(trackHeight(t,{density:'comfortable'}),98);
  const roots=groupTracks(Array.from({length:28},(_,i)=>track(i,1,`CORE0_UNIT_${i}`)),{1:'CORE0'});const compact=makeTrackLayout(roots),comfortable=makeTrackLayout(roots,{density:'comfortable'});
  assert.equal(compact.height,928);assert(compact.height<comfortable.height*.4);assert.equal(compact.rows.filter(r=>r.type==='track').length,28);
});
test('collapsed activity overview stays bounded and reads only in-memory block summaries',()=>{
  const trace={tracks:[{blocks:[0]}],blocks:[{start:10,end:100,summary:[{ts:10,dur:50,n:4},{ts:90,dur:10,n:2}]}],readBlock(){throw Error('must not read disk');}};
  const result=summarizeGroups(trace,[{id:'core',trackIds:[0]}],0,100,4000);assert.equal(result[0].bins.length,240);assert(result[0].bins.some(n=>n>0));assert(summarizeGroups(trace,[{id:'core',trackIds:[0]}],200,300,100)[0].bins.every(n=>n===0));
});
test('event field summary preserves supplied identities, shapes and traffic without inventing conclusions',()=>{
  const result=eventSummary({args:{core_id:0,linkid:81,opid:1,input:{shape:[12,12,64]},output_shape:[10,10,32],memory_traffic:{DRAM:{read_bytes:450900,write_bytes:0}},not_flow_id:999}});
  assert.equal(result.find(r=>r.label==='Core ID').value,'0');assert.equal(result.find(r=>r.label==='輸入 Shape').value,'[12,12,64]');assert.equal(result.find(r=>r.label==='DRAM 讀取').value,'450900 B');assert.equal(result.find(r=>r.label==='DRAM 寫入').value,'0 B');
  assert(!result.some(r=>r.section==='analysis'));assert.deepEqual(eventSummary({args:{not_flow_id:999,duration:10}}),[]);
  assert.equal(eventSummary({args:{bottleneck:'compute (trace supplied)',suggestion:'literal <text>'}}).find(r=>r.label==='來源建議').value,'literal <text>');
});
test('multi-core demo has four independent process groups and 28 tracks per core',()=>{
  const demo=hardwareDemo(),processes={},tracks=[];for(const event of demo.traceEvents){if(event.ph==='M'&&event.name==='process_name')processes[event.pid]=event.args.name;else if(event.ph==='M'&&event.name==='thread_name')tracks.push(track(tracks.length,event.pid,event.args.name));}
  const groups=groupTracks(tracks,processes);assert.equal(groups.length,4);assert(groups.every(g=>g.tracks.length===28));assert.equal(defaultCollapsed(groups).size,4);assert(demo.metadata.description.includes('Synthetic'));
});
test('counter curves are grouped together across processes without losing source identity or pins',()=>{
  const tracks=[track(0,1,'CORE0_COMPUTE'),{...track(1,1,'Power'),kind:'counter'},{...track(2,2,'Memory'),kind:'counter'},track(3,2,'CORE1_COMPUTE')],groups=groupTracks(tracks,{1:'CORE0',2:'CORE1'});
  const curves=groups.at(-1);assert.equal(curves.label,'數值曲線');assert.equal(curves.children.length,2);assert.deepEqual(curves.tracks.map(t=>t.pid),[1,2]);assert(groups.slice(0,-1).every(g=>g.tracks.every(t=>t.kind!=='counter')));
  const rows=makeTrackLayout(groups,{collapsed:defaultCollapsed(groups),pins:new Set([2]),filter:'CORE1'}).rows;assert.equal(rows[0].track.id,2);assert.equal(rows.filter(r=>r.type==='track'&&r.track.id===2).length,1);
  assert.equal(trackName({...track(4,1,'Thread 5'),tid:5}),'5');assert.equal(trackName(track(5,1,'Chrome_IOThread')),'Chrome_IOThread');
});

test('process groups use only source-owned names, including reserved string PIDs',()=>{
  const tracks=['__proto__','constructor','toString'].map((pid,id)=>track(id,pid,'DMA')),plain=groupTracks(tracks,{});
  for(const group of plain)assert.equal(group.label,'Process '+group.pid);
  const names=structuredClone(JSON.parse('{"__proto__":"CORE0","toString":"Accelerator 2"}')),named=groupTracks(tracks,names);assert.equal(named.find(g=>g.pid==='__proto__').label,'CORE0');assert.equal(named.find(g=>g.pid==='constructor').label,'Process constructor');assert.equal(named.find(g=>g.pid==='toString').label,'Accelerator 2');
});
