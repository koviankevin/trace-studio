import test from 'node:test';import assert from 'node:assert/strict';import {readTar} from '../dist/tar-stream.js';import {tarFixture} from './tar-fixture.mjs';
function stream(bytes,chunk=13){let at=0;return new ReadableStream({pull(controller){if(at===bytes.length){controller.close();return;}const end=Math.min(bytes.length,at+chunk);controller.enqueue(new Uint8Array(bytes.subarray(at,end)));at=end;}});}
const pax=record=>{let length=Buffer.byteLength(record)+3;while(Buffer.byteLength(`${length} ${record}\n`)!==length)length=Buffer.byteLength(`${length} ${record}\n`);return `${length} ${record}\n`;};
test('tar streams arbitrary boundaries and skips unsupported and unsafe members without host extraction',async()=>{
  const entries=[{name:'folder/a.json',data:'[{"name":"🌏"}]'},{name:'../bad.json',data:'bad'},{name:'symlink.json',type:'2'},{name:'readme.txt',data:'skip'},{name:'folder/b.json',data:'[]'}],bytes=tarFixture(entries);
  for(const chunk of [1,7,512,1024]){const files=[],skipped=[];await readTar(stream(bytes,chunk),{onFile:async(entry,body)=>{if(!entry.name.endsWith('.json'))return;files.push([entry.name,await new Response(body).text()]);},onSkip:entry=>skipped.push(entry.reason)});assert.deepEqual(files,[['folder/a.json','[{"name":"🌏"}]'],['folder/b.json','[]']]);assert.deepEqual(skipped,['unsafe-path','unsupported-type']);}
});
test('tar handles GNU long names and UTF-8 byte-counted PAX paths',async()=>{
  const name='資料/'+('long/'.repeat(30))+'trace.json',files=[];await readTar(stream(tarFixture([{name:'PaxHeader',type:'x',data:pax('path='+name)},{name:'short.json',data:'[]'},{name:'././@LongLink',type:'L',data:name+'\0'},{name:'other.json',data:'[]'}]),11),{onFile:async(entry,body)=>{files.push(entry.name);await new Response(body).text();}});assert.deepEqual(files,[name,name]);
});
test('tar rejects corrupt headers, truncated data, oversized metadata and malformed PAX records',async()=>{
  const valid=tarFixture([{name:'a.json',data:'[]'}]),bad=Buffer.from(valid);bad[0]^=1;
  for(const bytes of [bad,valid.subarray(0,513),tarFixture([{name:'meta',type:'x',data:'not pax'}]),tarFixture([{name:'meta',type:'L',data:'x'.repeat(65537)}])])await assert.rejects(readTar(stream(bytes),{onFile:async(entry,body)=>{await new Response(body).text();}}));
});

test('a fatal consumer error cancels the archive without draining a large remaining member',async()=>{
  const bytes=tarFixture([{name:'large.json',data:'x'.repeat(512*1024)}]);let offset=0,pulls=0,cancelled=false;const source=new ReadableStream({pull(controller){pulls++;const end=Math.min(bytes.length,offset+512);controller.enqueue(new Uint8Array(bytes.subarray(offset,end)));offset=end;if(offset===bytes.length)controller.close();},cancel(){cancelled=true;}});
  await assert.rejects(readTar(source,{onFile:async()=>{throw Error('stop immediately');}}),/stop immediately/);assert(cancelled);assert(pulls<5,'must not read the rest of a large file after quota/limit failure');
});

test('cancel while skipping a member does not wait for an upstream cancellation promise',async()=>{
  const bytes=tarFixture([{name:'unsupported',type:'2',data:'x'.repeat(1024*1024)}]);let offset=0,stop=false,pulls=0,cancelRequested=false;
  const source=new ReadableStream({pull(controller){const end=Math.min(bytes.length,offset+512);controller.enqueue(new Uint8Array(bytes.subarray(offset,end)));offset=end;if(++pulls===4)stop=true;},cancel(){cancelRequested=true;return new Promise(()=>{});}});
  await assert.rejects(readTar(source,{cancelled:()=>stop,onFile:async()=>{assert.fail('unsupported member');}}),{name:'AbortError'});assert(cancelRequested);assert(pulls<8);
});
