import test from 'node:test';
import assert from 'node:assert/strict';
import {counterPlot,formatCounterValue} from '../dist/counter-plot.js';

test('counter labels retain sub-unit values and scientific scales',()=>{
  assert.equal(formatCounterValue(0),'0');assert.equal(formatCounterValue(.00123),'0.00123');assert.equal(formatCounterValue(.0000012),'1.2e-6');assert.equal(formatCounterValue(-1.2e9),'-1.2e+9');assert.equal(formatCounterValue(Infinity),'—');
});
test('counter geometry scales tiny variations and centers constant values',()=>{
  const rows=[{ts:0,value:.0001},{ts:1,value:.0002}],plot=counterPlot({rows,start:0,end:1});
  assert.deepEqual(plot.points.map(p=>p.y),[0,1]);assert.equal(plot.min,.0001);assert.equal(plot.max,.0002);
  assert(counterPlot({rows:rows.map(r=>({...r,value:0})),start:0,end:1}).points.every(p=>p.y===.5));
});
test('counter boundary clipping interpolates only geometry without inventing event records',()=>{
  const before={ts:0,value:0},after={ts:1000,value:1000},plot=counterPlot({before,after,start:400,end:401});
  assert.deepEqual(plot.points.map(p=>[p.x,p.value,p.y]),[[0,400,0],[1,401,1]]);assert(plot.points.every(p=>p.interpolated&&p.record===null));assert.deepEqual(before,{ts:0,value:0});
  assert.equal(counterPlot({before,start:400,end:401}).points.length,0);
});
test('counter geometry retains original samples and stays finite for large signed values',()=>{
  const rows=[{ts:0,value:-1e308},{ts:1,value:1e308}],plot=counterPlot({rows,start:0,end:1});assert.equal(plot.points[0].record,rows[0]);assert.deepEqual(plot.points.map(p=>p.y),[0,1]);
  assert.equal(counterPlot({rows,start:1,end:1}).points.length,0);
});
