import test from 'node:test';import assert from 'node:assert/strict';import {formatTimestamp,formatTimeWindow} from '../dist/time-format.js';
test('late microsecond windows and ruler ticks retain distinct timestamps at the current zoom',()=>{
  const start=129448790,end=start+70,label=formatTimeWindow(start,end);assert.equal(label,'129.448790 s — 129.448860 s');const ticks=Array.from({length:8},(_,i)=>formatTimestamp(start+i*10,10));assert.equal(new Set(ticks).size,8);assert.equal(formatTimestamp(.125,.001),'0.125 µs');assert.equal(formatTimeWindow(1e12+100,1e12+170,1e12),'100 µs — 170 µs');
});
