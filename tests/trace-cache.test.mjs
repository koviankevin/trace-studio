import test from 'node:test';import assert from 'node:assert/strict';
import {TraceCache} from '../dist/trace-cache.js';
const entry=(id,size)=>({sessionId:id,source:{size}});
test('small trace indexes use a bounded idle cache, large traces stay on disk',()=>{
  const cache=new TraceCache(64);assert.deepEqual(cache.put(entry('large',65e6)).map(value=>value.sessionId),['large']);
  assert.deepEqual(cache.put({...entry('gzip',1e6),activeManifest:{diskBytes:80e6}}).map(value=>value.sessionId),['gzip']);
  cache.put(entry('a',60e6));cache.put(entry('b',60e6));assert.deepEqual(cache.put(entry('c',60e6)).map(value=>value.sessionId),['a']);assert.equal(cache.take('b').sessionId,'b');assert(!cache.has('b'));
  assert.deepEqual(cache.configure(32).map(value=>value.sessionId),['c']);cache.put(entry('a',1));cache.put(entry('b',1));cache.put(entry('c',1));assert.deepEqual(cache.put(entry('d',1)).map(value=>value.sessionId),['a']);assert.equal(cache.drain().length,3);assert.equal(cache.entries.size,0);assert.throws(()=>cache.configure(-1));
});
