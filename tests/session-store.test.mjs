import test from 'node:test';
import assert from 'node:assert/strict';
import {locks} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {createSessionStore} from '../dist/session-store.js';

function directory(files){return {async getFileHandle(name){if(!(name in files))throw new DOMException('missing','NotFoundError');return {getFile:async()=>files[name]};}};}
function rootFor(id,files){return {async*keys(){yield id;yield 'unrelated';},async getDirectoryHandle(name){assert.equal(name,id);return directory(files);},async removeEntry(name){assert.equal(name,id);this.removed=true;}};}
const metadata=text=>({size:Buffer.byteLength(text),text:async()=>text});

test('cache listing reads only bounded summaries and file sizes, never raw event bytes',async()=>{
  const id=randomUUID(),unreadable={size:3_000_000_000,text(){assert.fail('must not read event content');}},manifest={size:50_000_000,text(){assert.fail('must not read a large legacy manifest');}};
  const root=rootFor(id,{'events.bin':unreadable,'index.bin':{size:1000},'relations.bin':{size:100},'manifest.json':manifest});
  const entries=await createSessionStore(async()=>root).list(id);
  assert.equal(entries.length,1);assert.equal(entries[0].bytes,3_050_001_100);assert(entries[0].current&&entries[0].complete);
});

test('cache deletion holds an exclusive session lease and skips a live owner',async()=>{
  const id=randomUUID(),root=rootFor(id,{'manifest.json':metadata('{}')}),owner=createSessionStore(async()=>root,locks),cleaner=createSessionStore(async()=>root,locks);
  const lease=await owner.lease(id);
  try{const result=await cleaner.remove(id);assert.equal(result.reason,'busy');assert(!root.removed);assert((await cleaner.list())[0].busy);}
  finally{await lease.release();}
  assert((await cleaner.remove(id)).removed);assert(root.removed);
});

test('legacy metadata stays compatible; invalid IDs and unsafe incomplete cleanup are rejected',async()=>{
  const id=randomUUID(),root=rootFor(id,{'manifest.json':metadata(JSON.stringify({source:{name:'legacy.json'},count:17}))});
  const store=createSessionStore(async()=>root);assert.equal((await store.list())[0].name,'legacy.json');
  await assert.rejects(store.remove('../outside'),/識別碼/);assert(!root.removed);
  const incomplete=rootFor(id,{'session.json':metadata('{broken')});
  const result=await createSessionStore(async()=>incomplete).remove(id);assert.equal(result.reason,'unsupported');assert(!incomplete.removed);
});
