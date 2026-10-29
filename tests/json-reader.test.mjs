import test from 'node:test';
import assert from 'node:assert/strict';
import {TraceJSONReader} from '../dist/core.js';

function read(text,chunks){
  const events=[],metadata={},reader=new TraceJSONReader((event,raw)=>events.push({event,raw}),(key,value)=>metadata[key]=value);
  let at=0,index=0;while(at<text.length){const size=chunks[index++%chunks.length];reader.feed(text.slice(at,at+size));at+=size;}reader.end();return {events,metadata};
}
test('streaming reader accepts JSON whitespace and rejects JavaScript-only whitespace outside strings',()=>{
  for(const gap of [' ','\t','\r','\n',' \r\n\t'])assert.equal(read(gap+'['+gap+'{}'+gap+']'+gap,[1,2,7]).events.length,1);
  for(const gap of ['\u00a0','\u2028','\u2029','\v','\f','\ufeff']){
    for(const input of ['['+gap+'{}]', '[{}]'+gap, '{"meta":1'+gap+',"traceEvents":[]}'])assert.throws(()=>read(input,[1,3,19]),/JSON/);
    assert.equal(read(JSON.stringify([{name:gap}]),[1,2,3]).events[0].event.name,gap);
  }
  assert.equal(read('\ufeff[{}]',[1]).events.length,1,'a leading UTF-8 BOM remains supported');
});
test('long strings preserve exact raw text across quote, escape and surrogate chunk boundaries',()=>{
  const event={name:'long " \\ '+ 'x'.repeat(12000),ph:'X',ts:12,dur:3,args:{payload:'}'+'["\\\n中文🌏'.repeat(2000),tail:'\\'.repeat(31),empty:'',unicode:'\u0000\b\t\r\n'}},raw=' { "name" : '+JSON.stringify(event.name)+', "ph":"X", "ts":12, "dur":3, "args":'+JSON.stringify(event.args)+' } ';
  for(const sizes of [[1],[2,3,5,7],[31,1024,13],[65536]]){
    const result=read('{"before":"escaped \\\" key","traceEvents":['+raw+','+raw+'],"after":[true,false,null,-12.3e2]}',sizes);
    assert.deepEqual(result.events.map(row=>row.event),[event,event]);assert.deepEqual(result.events.map(row=>row.raw),[raw.trim(),raw.trim()]);assert.deepEqual(result.metadata,{before:'escaped " key',after:[true,false,null,-1230]});
  }
});
test('seeded nested JSON values match JSON.parse under irregular stream boundaries',()=>{
  let seed=42891;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;},strings=['','"','\\','\\"','\\\\"','中文🌏','{}[],:','\u2028\u0000\n','traceEvents'];
  const value=depth=>{const n=random()%6;if(depth>3||n<3)return n===0?strings[random()%strings.length]:n===1?random()/8192:null;if(n===3)return [value(depth+1),value(depth+1)];return Object.fromEntries(Array.from({length:random()%5},(_,i)=>[strings[random()%strings.length]+i,value(depth+1)]));};
  for(let run=0;run<160;run++){
    const events=Array.from({length:1+random()%12},()=>({name:strings[random()%strings.length],args:value(0),pid:1,tid:2,ts:random(),dur:1})),metadata=value(0),text=JSON.stringify({metadata,traceEvents:events,tail:'\\"🌏'}),result=read(text,[1+random()%3,1+random()%113,1+random()%257]);
    assert.deepEqual(result.events.map(row=>row.event),JSON.parse(text).traceEvents);assert.deepEqual(result.metadata,{metadata,tail:'\\"🌏'});for(const row of result.events)assert.deepEqual(JSON.parse(row.raw),row.event);
  }
});
test('skipped string payloads still respect token limits and reject incomplete escapes and invalid controls',()=>{
  const event={name:'x'.repeat(400)},reader=new TraceJSONReader(()=>assert.fail('oversized event was emitted'));reader.maxToken=256;assert.throws(()=>reader.feed(JSON.stringify([event])),/超過/);
  const partial=new TraceJSONReader(()=>assert.fail('oversized partial event was emitted'));partial.maxToken=256;assert.throws(()=>partial.feed('[{"name":"'+'x'.repeat(400)),/超過/);
  for(const text of ['[{"name":"abc\\','[{"name":"abc\\"}]','[{"name":"abc\n"}]','[{"name":"\\u12xz"}]','[{"name":"\\z"}]','[{"name":"'+'x'.repeat(10000)])assert.throws(()=>read(text,[7,1,53]),/JSON/);
});
