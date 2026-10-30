import {normalizeAddress} from './relations.js?v=0.4.0';

// Add aliases here, or pass idFields to extractArgumentFacts for a local schema.
export const DEFAULT_ID_FIELDS={
  tflite:['tfliteid','tfliteopid'],flow:['linkid'],opg:['groupid'],core:['coreid','coreidx'],
  tile:['blockid'],subtile:['subblockid'],subcommand:['commandid']
};
export const DEFAULT_MEMORY_FIELDS={start:['rangestart'],end:['rangeend'],size:['size'],location:['space']};
export function createArgumentSchema(definitions=[]){
  const schema={idFields:structuredClone(DEFAULT_ID_FIELDS),memoryFields:structuredClone(DEFAULT_MEMORY_FIELDS),identityFields:['identity']};
  for(const definition of definitions){
    if(!definition||typeof definition!=='object'||Array.isArray(definition))throw Error('argumentSchema 必須是物件');
    for(const [section,fields]of Object.entries(definition)){
      if(!Object.hasOwn(schema,section))throw Error('未知的 argumentSchema 設定');
      const append=(target,names)=>{if(!Array.isArray(names)||names.length>32||names.some(name=>typeof name!=='string'||name.length<1||name.length>80))throw Error('欄位別名必須是最多 32 個名稱的陣列');return [...new Set([...target,...names])].slice(0,64);};
      if(section==='identityFields')schema.identityFields=append(schema.identityFields,fields);
      else{if(!fields||typeof fields!=='object'||Array.isArray(fields))throw Error('欄位對應必須是物件');for(const [kind,names]of Object.entries(fields)){if(!Object.hasOwn(schema[section],kind))throw Error('未知的欄位種類');schema[section][kind]=append(schema[section][kind],names);}}
    }
  }return schema;
}
const key=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
export function normalizeIdentifier(value){
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?String(value):null;
  if(typeof value!=='string'||!value.trim()||value.length>160)return null;
  const text=value.trim();if(/^-?\d+$|^0x[0-9a-f]+$/i.test(text)){try{const n=BigInt(text);return n>=0?String(n):null;}catch{return null;}}
  return text;
}
const address=value=>typeof value==='string'&&value.length>128?null:normalizeAddress(value);
const integer=value=>{const id=normalizeIdentifier(value);try{return id!==null&&/^\d+$/.test(id)?BigInt(id):null;}catch{return null;}};
export function extractArgumentFacts(event,{idFields=DEFAULT_ID_FIELDS,memoryFields=DEFAULT_MEMORY_FIELDS,identityFields=['identity'],maxNodes=4096,maxRanges=32}={}){
  const candidates=new Map(),memories=[],warnings=[],seen=new Set();let visited=0,truncated=false;
  const warn=message=>{if(warnings.length<32)warnings.push(message);};
  const put=(kind,value,path,priority)=>{const id=normalizeIdentifier(value);if(id===null)return;if(!candidates.has(kind))candidates.set(kind,[]);if(candidates.get(kind).length<64)candidates.get(kind).push({value:id,path,priority});else truncated=true;};
  const aliases=new Map(Object.entries(idFields).flatMap(([kind,fields])=>fields.map(field=>[key(field),kind])));
  const rangeAliases=new Map(Object.entries(memoryFields).flatMap(([kind,fields])=>fields.map(field=>[key(field),kind]))),identities=new Set(identityFields.map(key));
  function memory(obj,path){
    const slots=new Map();let count=0;for(const name in obj){if(!Object.hasOwn(obj,name))continue;if(++count>maxNodes-visited){truncated=true;break;}const value=obj[name];
      const normalized=key(name),match=normalized.match(/^(.*?)(\d*)$/),kind=rangeAliases.get(match[1]);if(!kind)continue;
      const index=match[2]||'0';if(!slots.has(index))slots.set(index,{});slots.get(index)[kind]=value;
    }
    for(const [index,slot]of slots){if(slot.start===undefined)continue;if(memories.length>=maxRanges){truncated=true;break;}
      const start=address(slot.start),rawEnd=slot.end===undefined?null:address(slot.end),size=integer(slot.size);
      if(!start||slot.end!==undefined&&!rawEnd){warn(`${path}[${index}]：位址無效或超出安全數字，請使用十六進位字串。`);continue;}
      let end=rawEnd?BigInt(rawEnd):null,basis='unverified-inclusive',sizeMatches=null;
      if(end!==null&&end<BigInt(start)){warn(`${path}[${index}]：結束位址小於起點。`);continue;}
      if(size===0n){warn(`${path}[${index}]：零大小區段未納入位址比對。`);continue;}
      if(end===null){if(size===null)continue;end=BigInt(start)+size-1n;basis='start-and-size';sizeMatches=true;}
      else if(size!==null){if(size===end-BigInt(start)+1n){basis='size-confirmed-inclusive';sizeMatches=true;}else if(size===end-BigInt(start)){end--;basis='size-confirmed-exclusive';sizeMatches=true;}else{sizeMatches=false;warn(`${path}[${index}]：Size 與起訖範圍不符，暫以含尾端的候選範圍比對。`);}}
      const location=typeof slot.location==='string'?slot.location.slice(0,160):slot.location===undefined?'未知':String(slot.location),upper=location.toUpperCase();
      const space=upper.match(/(?:^|_)(DRAM|LOCAL|CACHE|SRAM)(?:_|$)/)?.[1]||upper;
      const role=/(?:^|_)(OUTPUT|OUT)(?:_|$)/.test(upper)?'output':/(?:^|_)(INPUT|IN)(?:_|$)/.test(upper)?'input':'unknown';
      memories.push({start,end:'0x'+end.toString(16),rawEnd,bytes:String(end-BigInt(start)+1n),declaredBytes:size===null?null:String(size),location,space,role,basis,sizeMatches,path:`${path}[${index}]`});
    }
  }
  function walk(value,path,depth){
    if(!value||typeof value!=='object')return;if(depth>8||visited>=maxNodes){truncated=true;return;}if(seen.has(value))return;seen.add(value);
    memory(value,path);
    for(const name in value){if(!Object.hasOwn(value,name))continue;
      if(++visited>maxNodes){truncated=true;break;}const child=value[name],next=`${path}.${name}`,kind=aliases.get(key(name));
      if(kind)put(kind,child,next,depth);
      if(identities.has(key(name))&&typeof child==='string'){
        if(child.length>2400)truncated=true;const text=child.slice(0,2400);for(const match of text.matchAll(/(?:^|[\s,[;])([a-zA-Z]+[iI][dD])(?:\s*[:=]\s*|\s+)([^\s,;\]\)]+)/g)){const field=aliases.get(key(match[1]));if(field)put(field,match[2],next,100+depth);}
      }
      if(child&&typeof child==='object')walk(child,next,depth+1);
    }
  }
  walk(event.args,'args',0);const ids={},sources={},conflicts=[];
  for(const [kind,values]of candidates){values.sort((a,b)=>a.priority-b.priority);ids[kind]=values[0].value;sources[kind]=values[0].path;for(const other of values.slice(1))if(other.value!==ids[kind]&&conflicts.length<32)conflicts.push({kind,chosen:ids[kind],other:other.value,path:other.path});}
  return {ids,sources,memories,warnings,conflicts,truncated};
}
export function extractRecordFacts({event,endEvent},options){
  const facts=extractArgumentFacts(event,options);if(!endEvent)return facts;
  const endFacts=extractArgumentFacts(endEvent,options);
  for(const [kind,value]of Object.entries(endFacts.ids)){if(facts.ids[kind]===undefined){facts.ids[kind]=value;facts.sources[kind]='endEvent.'+endFacts.sources[kind];}else if(facts.ids[kind]!==value)facts.conflicts.push({kind,chosen:facts.ids[kind],other:value,path:'endEvent.'+endFacts.sources[kind]});}
  for(const memory of endFacts.memories){if(facts.memories.some(prior=>prior.start===memory.start&&prior.end===memory.end&&prior.location===memory.location))continue;if(facts.memories.length<32)facts.memories.push({...memory,path:'endEvent.'+memory.path});else facts.truncated=true;}
  facts.warnings.push(...endFacts.warnings);facts.conflicts.push(...endFacts.conflicts);facts.truncated||=endFacts.truncated;
  if(facts.warnings.length>32||facts.conflicts.length>32)facts.truncated=true;facts.warnings=facts.warnings.slice(0,32);facts.conflicts=facts.conflicts.slice(0,32);return facts;
}
export function compareMemory(a,b){
  if(a.space!==b.space)return null;
  const left=BigInt(a.start)>BigInt(b.start)?BigInt(a.start):BigInt(b.start),right=BigInt(a.end)<BigInt(b.end)?BigInt(a.end):BigInt(b.end);
  if(left>right)return null;
  return {kind:a.start===b.start&&a.end===b.end?'same':'overlap',start:'0x'+left.toString(16),end:'0x'+right.toString(16),bytes:String(right-left+1n),direction:a.role==='output'&&b.role==='input'?'output-input':a.role==='input'&&b.role==='output'?'input-output':'same-address'};
}
