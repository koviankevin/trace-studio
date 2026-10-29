// Reproducible synthetic browser File fixture; never overwrite an existing file.
import fs from 'node:fs';
import path from 'node:path';
const filename=path.resolve(process.argv[2]||'evidence/browser-fixtures/synthetic-3gb-v0.12.0.json'),target=Number(process.argv[3]||3000000000);
if(!Number.isSafeInteger(target)||target<1)throw Error('Invalid size');
fs.mkdirSync(path.dirname(filename),{recursive:true});const fd=fs.openSync(filename,'wx'),header='{"traceEvents":[',payload='x'.repeat(900);let bytes=header.length,events=0,batch='';
try{
  fs.writeSync(fd,header);
  while(bytes<target){batch+=`${events?',':''}{"name":"Task ${events%12}","ph":"X","pid":1,"tid":${events%8},"ts":${events*100},"dur":50,"cat":"benchmark","args":{"payload":"${payload}","index":${events}${events%25===0?`,"address":"0x${(events%8192+4096).toString(16)}"`:''}}}`;events++;
    if(batch.length>=1024*1024){fs.writeSync(fd,batch);bytes+=batch.length;batch='';}}
  if(batch)fs.writeSync(fd,batch);fs.writeSync(fd,']}');fs.fsyncSync(fd);
}finally{fs.closeSync(fd);}
console.log(JSON.stringify({filename,bytes:fs.statSync(filename).size,events,synthetic:true}));
