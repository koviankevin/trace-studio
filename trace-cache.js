// Idle indexes only; raw events remain on disk. The active index is separate.
export class TraceCache {
  constructor(limitMB=64){this.entries=new Map();this.configure(limitMB);}
  configure(limitMB){if(![0,32,64,128,256].includes(limitMB))throw Error('無效的小檔快取門檻');this.limit=limitMB*1e6;this.budget=Math.min(512e6,this.limit*2);return this.trim();}
  has(id){return this.entries.has(id);}
  peek(id){return this.entries.get(id);}
  take(id){const value=this.entries.get(id);this.entries.delete(id);return value;}
  weight(value){return Math.max(Number(value.source?.size)||0,(Number(value.activeManifest?.diskBytes)||0)+(Number(value.activeManifest?.relations?.bytes)||0));}
  put(value){const evicted=[];const prior=this.take(value.sessionId);if(prior&&prior!==value)evicted.push(prior);if(!this.limit||!Number.isFinite(value.source?.size)||this.weight(value)>this.limit){evicted.push(value);return evicted;}this.entries.set(value.sessionId,value);return [...evicted,...this.trim()];}
  trim(){const evicted=[];for(const [id,value]of this.entries)if(!this.limit||this.weight(value)>this.limit){this.entries.delete(id);evicted.push(value);}while(this.entries.size>3||[...this.entries.values()].reduce((sum,value)=>sum+this.weight(value),0)>this.budget){const id=this.entries.keys().next().value;evicted.push(this.take(id));}return evicted;}
  drain(){const values=[...this.entries.values()];this.entries.clear();return values;}
}
