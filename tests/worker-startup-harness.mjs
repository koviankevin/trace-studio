// Deliberately delivers the UI's first message while custom modules load.
// Unlike worker-harness, it must not wait for module evaluation to complete.
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadExtensionHost} from '../dist/extensions/runtime.js';
let release,started;
const gate=new Promise(resolve=>release=resolve),loading=new Promise(resolve=>started=resolve);
const messages=[];
const context=vm.createContext({
  onmessage:null,postMessage:message=>messages.push(message),
  navigator:{storage:{estimate:async()=>({quota:0,usage:0})}},
  performance,File,crypto,console,setTimeout,clearTimeout
});
const url=new URL('../dist/worker.js',import.meta.url);
const module=new vm.SourceTextModule(await readFile(url,'utf8'),{context,identifier:url.href});
await module.link(async specifier=>{
  const values=specifier==='./extensions/runtime.js'
    ?{loadExtensionHost:async()=>{started();await gate;return loadExtensionHost();}}
    :await import(new URL(specifier,url));
  return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});
});
const evaluating=module.evaluate();await loading;
// A quota rejection proves the actual import handler received this file,
// without requiring a fake disk implementation in this startup-only test.
const file=new File(['[]'],'early.json');
const delivered=context.onmessage?.({data:{type:'import',file}});
release();await evaluating;await delivered;
assert.equal(messages[0]?.operation,'import','first file import was lost while extensions initialized');
assert.match(messages[0].message,/空間不足/);
console.log('early import completed');
