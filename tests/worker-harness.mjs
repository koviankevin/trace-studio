import {parentPort,workerData,locks} from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
const root=workerData.root;
const failOpenOnce=new Set(workerData.failOpenOnce||[]);
let writeFault=null;
function checkWrite(filename,at,length){if(writeFault&&path.basename(filename)===writeFault.name&&at+length>writeFault.after){writeFault=null;throw new DOMException('Injected disk quota exceeded','QuotaExceededError');}}
class FileHandle{
  constructor(filename){this.filename=filename;}
  async createSyncAccessHandle(){if(failOpenOnce.delete(path.basename(this.filename)))throw Error('Injected disk open failure');const fd=fs.openSync(this.filename,'r+');return {write:(b,{at})=>{checkWrite(this.filename,at,b.length);return fs.writeSync(fd,b,0,b.length,at);},read:(b,{at})=>{if(workerData.relationReadDelayMs&&path.basename(this.filename)==='relations.bin'){const end=performance.now()+workerData.relationReadDelayMs;while(performance.now()<end){}}return fs.readSync(fd,b,0,b.length,at);},flush:()=>fs.fsyncSync(fd),close:()=>fs.closeSync(fd)};}
  async createWritable(){const fd=fs.openSync(this.filename,'w');let offset=0,closed=false;const close=async()=>{if(!closed){closed=true;fs.closeSync(fd);}};return {write:async value=>{const b=typeof value==='string'?Buffer.from(value):new Uint8Array(await value.arrayBuffer());checkWrite(this.filename,offset,b.length);fs.writeSync(fd,b,0,b.length,offset);offset+=b.length;},close,abort:close};}
  async getFile(){return new File([fs.readFileSync(this.filename)],path.basename(this.filename));}
}
class Directory{
  constructor(folder){this.folder=folder;}
  async getDirectoryHandle(name,{create=false}={}){if(name.includes('/')||name.includes('\\'))throw Error('invalid path');const folder=path.join(this.folder,name);if(create)fs.mkdirSync(folder,{recursive:true});if(!fs.statSync(folder).isDirectory())throw Error('not dir');return new Directory(folder);}
  async getFileHandle(name,{create=false}={}){const filename=path.join(this.folder,name);if(create&&!fs.existsSync(filename))fs.closeSync(fs.openSync(filename,'w'));if(!fs.existsSync(filename))throw Error('not found');return new FileHandle(filename);}
  async removeEntry(name,{recursive=false}={}){const filename=path.join(this.folder,name);if(path.dirname(filename)!==this.folder)throw Error('unsafe path');fs.rmSync(filename,{recursive,maxRetries:3,retryDelay:50});}
  async* keys(){yield* fs.readdirSync(this.folder);}
}
Object.defineProperty(globalThis,'navigator',{value:{locks,storage:{getDirectory:async()=>new Directory(root),estimate:async()=>(workerData.storageEstimate??{quota:1e12,usage:0})}}});
globalThis.postMessage=message=>parentPort.postMessage(message);globalThis.onmessage=null;
await import(workerData.entry||'../dist/worker.js');
parentPort.on('message',data=>{
  if(data.type==='testWriteFault'){writeFault={name:data.name,after:data.after||0};parentPort.postMessage({type:'testWriteFaultConfigured',requestId:data.requestId});return;}
  if(data.type==='testQuotaEstimate'){workerData.storageEstimate=data.estimate;parentPort.postMessage({type:'testQuotaConfigured',requestId:data.requestId});return;}
  if(data.type==='import'&&workerData.pendingCancel){const file=data.file;data.file={name:file.name,size:file.size,slice:file.slice.bind(file),stream(){const reader=file.stream().getReader();return new ReadableStream({async pull(controller){const {value,done}=await reader.read();if(done)controller.close();else controller.enqueue(value);},cancel(){reader.cancel().catch(()=>{});return new Promise(()=>{});}});}};}
  if(data.type==='import'&&workerData.slowInput){const file=data.file;data.file={name:file.name,size:file.size,slice:file.slice.bind(file),stream:()=>file.stream().pipeThrough(new TransformStream({async transform(chunk,controller){for(let at=0;at<chunk.length;at+=16*1024){controller.enqueue(chunk.subarray(at,at+16*1024));await new Promise(resolve=>setTimeout(resolve,20));}}}))};}
  return globalThis.onmessage({data});
});parentPort.postMessage({type:'initialized'});
