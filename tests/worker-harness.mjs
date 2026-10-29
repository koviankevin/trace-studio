import {parentPort,workerData} from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
const root=workerData.root;
class FileHandle{
  constructor(filename){this.filename=filename;}
  async createSyncAccessHandle(){const fd=fs.openSync(this.filename,'r+');return {write:(b,{at})=>fs.writeSync(fd,b,0,b.length,at),read:(b,{at})=>fs.readSync(fd,b,0,b.length,at),flush:()=>fs.fsyncSync(fd),close:()=>fs.closeSync(fd)};}
  async createWritable(){const fd=fs.openSync(this.filename,'w');let offset=0;return {write:async value=>{const b=typeof value==='string'?Buffer.from(value):new Uint8Array(await value.arrayBuffer());fs.writeSync(fd,b,0,b.length,offset);offset+=b.length;},close:async()=>fs.closeSync(fd)};}
  async getFile(){return new File([fs.readFileSync(this.filename)],path.basename(this.filename));}
}
class Directory{
  constructor(folder){this.folder=folder;}
  async getDirectoryHandle(name,{create=false}={}){if(name.includes('/')||name.includes('\\'))throw Error('invalid path');const folder=path.join(this.folder,name);if(create)fs.mkdirSync(folder,{recursive:true});if(!fs.statSync(folder).isDirectory())throw Error('not dir');return new Directory(folder);}
  async getFileHandle(name,{create=false}={}){const filename=path.join(this.folder,name);if(create&&!fs.existsSync(filename))fs.closeSync(fs.openSync(filename,'w'));if(!fs.existsSync(filename))throw Error('not found');return new FileHandle(filename);}
  async removeEntry(name,{recursive=false}={}){const filename=path.join(this.folder,name);if(path.dirname(filename)!==this.folder)throw Error('unsafe path');fs.rmSync(filename,{recursive});}
  async* keys(){yield* fs.readdirSync(this.folder);}
}
Object.defineProperty(globalThis,'navigator',{value:{storage:{getDirectory:async()=>new Directory(root),estimate:async()=>({quota:1e12,usage:0})}}});
globalThis.postMessage=message=>parentPort.postMessage(message);globalThis.onmessage=null;
await import('../dist/worker.js');
parentPort.on('message',data=>globalThis.onmessage({data}));parentPort.postMessage({type:'initialized'});
