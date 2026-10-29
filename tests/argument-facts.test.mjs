import test from 'node:test';
import assert from 'node:assert/strict';
import {extractArgumentFacts,compareMemory,normalizeIdentifier} from '../dist/argument-facts.js';
import {shortTid} from '../dist/event-labels.js';
test('short tids remove a delimited process prefix without subtracting unrelated numeric IDs',()=>{
  assert.equal(shortTid('CORE0_COMPUTE','CORE0'),'COMPUTE');assert.equal(shortTid('CORE0_COMPUTE work',100,'CORE0'),'COMPUTE work');assert.equal(shortTid(123,12),'123');assert.equal(shortTid('CORE01_COMPUTE','CORE0'),'CORE01_COMPUTE');
});
test('argument IDs normalize case and numeric representation, keep zero and prefer explicit fields over Identity',()=>{
  const result=extractArgumentFacts({args:{Identity:'[commandId 7, coreId 2, linkId 41, groupId 6, blockId 11, subblockId 0] tfliteId 280',LinkId:42,TfliteID:'00280'}});
  assert.deepEqual(result.ids,{flow:'42',tflite:'280',subcommand:'7',core:'2',opg:'6',tile:'11',subtile:'0'});assert.equal(result.sources.flow,'args.LinkId');assert(result.conflicts.some(c=>c.kind==='flow'&&c.other==='41'));
  assert.equal(normalizeIdentifier(2**60),null);assert.equal(normalizeIdentifier('-1'),null);assert.equal(normalizeIdentifier('0x118'),'280');
});
test('MemoryRanges fields pair by parent and numeric suffix, and detect inclusive versus exclusive ends',()=>{
  const result=extractArgumentFacts({args:{MemoryRanges:{'Range Start 0':'0x1000','Range End 0':'0x1fff','Size 0':4096,'Space 0':'LOC_OUTPUT_LOCAL','Range Start 1':'0x2000','Range End 1':'0x2100','Size 1':256,'Space 1':'LOC_INPUT_DRAM'}}});
  assert.equal(result.memories.length,2);assert.equal(result.memories[0].role,'output');assert.equal(result.memories[0].bytes,'4096');assert.equal(result.memories[1].end,'0x20ff');assert.equal(result.memories[1].basis,'size-confirmed-exclusive');
});
test('nested memory ranges never pair fields from different objects and preserve size mismatches',()=>{
  const result=extractArgumentFacts({args:{a:{RangeStart:'0x1000'},b:{RangeEnd:'0x1fff',Size:4096},c:{RangeStart:'0x2000',RangeEnd:'0x20ff',Size:100,Space:'LOC_OUTPUT_LOCAL'}}});
  assert.equal(result.memories.length,1);assert.equal(result.memories[0].sizeMatches,false);assert(result.warnings.length);
});
test('memory matching distinguishes range equality and overlaps within the same memory space',()=>{
  const a=extractArgumentFacts({args:{MemoryRanges:{RangeStart:'0x1000',Size:256,Space:'LOC_OUTPUT_LOCAL'}}}).memories[0],b={...a,start:'0x1080',end:'0x11ff',role:'input'};
  assert.deepEqual(compareMemory(a,b),{kind:'overlap',start:'0x1080',end:'0x10ff',bytes:'128',direction:'output-input'});assert.equal(compareMemory(a,{...b,space:'DRAM'}),null);assert.equal(compareMemory(a,a).kind,'same');
});
test('fact extraction is bounded and supports local field aliases without executing trace text',()=>{
  const args={CustomOperation:'7',Identity:'linkId 0',deep:{x:{y:{z:1}}}};args.cycle=args;
  const result=extractArgumentFacts({args},{idFields:{tflite:['customoperation'],flow:['linkid']},maxNodes:3});assert.equal(result.ids.tflite,'7');assert(result.truncated);
});
