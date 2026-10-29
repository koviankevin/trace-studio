// Sequential tar reader. No extraction paths or archive-sized buffers are created.
const decoder=new TextDecoder();
const text=(bytes,start=0,length=bytes.length)=>decoder.decode(bytes.subarray(start,start+length)).split('\0')[0];
function number(bytes){
  let value=0n;
  if(bytes[0]&128){if(bytes[0]&64)throw Error('tar 含負數大小');value=BigInt(bytes[0]&127);for(const byte of bytes.subarray(1))value=value*256n+BigInt(byte);}
  else{const raw=text(bytes).trim();if(raw&&!/^[0-7]+$/.test(raw))throw Error('tar 數字欄位無效');value=raw?BigInt('0o'+raw):0n;}
  if(value>BigInt(Number.MAX_SAFE_INTEGER))throw Error('tar 檔案大小超出可處理範圍');return Number(value);
}
function pax(bytes){const result=Object.create(null);let offset=0;
  while(offset<bytes.length){const space=bytes.indexOf(32,offset),raw=space<0?'':text(bytes,offset,space-offset);if(!/^\d+$/.test(raw))throw Error('PAX 欄位長度無效');const length=Number(raw),end=offset+length;if(!Number.isSafeInteger(length)||length<=space-offset+2||end>bytes.length||bytes[end-1]!==10)throw Error('PAX 欄位不完整');const record=bytes.subarray(space+1,end-1),equals=record.indexOf(61);if(equals<=0)throw Error('PAX 欄位無效');const key=text(record,0,equals);if(key==='path'||key==='size')result[key]=decoder.decode(record.subarray(equals+1));if(key.startsWith('GNU.sparse'))result.sparse='1';offset=end;}
  return result;
}
class Input {
  constructor(stream,cancelled){this.reader=stream.getReader();this.cancelled=cancelled;this.chunk=new Uint8Array();this.offset=0;}
  abort(){if(this.cancelled())throw Object.assign(Error('已取消封裝讀取'),{name:'AbortError'});}
  async part(max){this.abort();while(this.offset>=this.chunk.length){const result=await this.reader.read();this.abort();if(result.done)return null;this.chunk=result.value;this.offset=0;}const part=this.chunk.subarray(this.offset,this.offset+Math.min(max,this.chunk.length-this.offset));this.offset+=part.length;return part;}
  async exact(size,allowEnd=false){const bytes=new Uint8Array(size);let offset=0;while(offset<size){const part=await this.part(size-offset);if(!part){if(!offset&&allowEnd)return null;throw Error('tar 檔案內容不完整');}bytes.set(part,offset);offset+=part.length;}return bytes;}
  async skip(size){while(size){const part=await this.part(Math.min(size,65536));if(!part)throw Error('tar 成員內容不完整');size-=part.length;}}
}
export async function readTar(stream,{onFile,onSkip=()=>{},cancelled=()=>false,maxHeaders=10000,maxMetadataBytes=65536}={}){
  const input=new Input(stream,cancelled);let headers=0,files=0,zeros=0,longName=null,local=Object.create(null),global=Object.create(null);
  try{for(;;){const header=await input.exact(512,true);if(!header)throw Error('tar 缺少結尾區塊');
    if(header.every(byte=>byte===0)){if(++zeros<2)continue;let padding=0;for(;;){const part=await input.part(65536);if(!part)return {headers,files};padding+=part.length;if(padding>1048576||part.some(byte=>byte!==0))throw Error('tar 結尾包含額外資料或過多填充');}}else if(zeros)throw Error('tar 結尾區塊不完整');
    if(++headers>maxHeaders)throw Error('tar 成員數超過 10,000 上限');
    const checksum=number(header.subarray(148,156)),sum=header.reduce((total,byte,index)=>total+(index>=148&&index<156?32:byte),0);if(sum!==checksum)throw Error('tar header checksum 不符');
    const type=String.fromCharCode(header[156]),headerSize=number(header.subarray(124,136));
    if(['x','g','L','K'].includes(type)){if(headerSize>maxMetadataBytes)throw Error('tar 延伸 metadata 超過 64 KiB');const data=await input.exact(headerSize);await input.skip((512-headerSize%512)%512);if(type==='L')longName=text(data).replace(/\n$/,'');else if(type==='x')local=pax(data);else if(type==='g')for(const [key,value]of Object.entries(pax(data))){if(value==='')delete global[key];else global[key]=value;}continue;}
    const attributes={...global,...local};let name=attributes.path||longName||[text(header,257,6)==='ustar'?text(header,345,155):'',text(header,0,100)].filter(Boolean).join('/');let size=headerSize;
    if(attributes.size!==undefined&&attributes.size!==''){if(!/^\d+$/.test(attributes.size)||!Number.isSafeInteger(Number(attributes.size)))throw Error('PAX size 無效');size=Number(attributes.size);}
    local=Object.create(null);longName=null;name=name.replaceAll('\\','/');
    const regular=(type==='0'||type==='\0')&&!attributes.sparse,safe=name.length>0&&name.length<=4096&&!name.startsWith('/')&&!/^[a-z]:/i.test(name)&&!name.split('/').includes('..');
    if(!regular||!safe){onSkip({name,size,type,reason:!safe?'unsafe-path':'unsupported-type'});await input.skip(size);}else{
      files++;let remaining=size;const body=new ReadableStream({async pull(controller){if(!remaining){controller.close();return;}const part=await input.part(Math.min(remaining,65536));if(!part)throw Error('tar 成員內容不完整');remaining-=part.length;controller.enqueue(part);if(!remaining)controller.close();}},{highWaterMark:0});
      let completed=false;try{await onFile({name,size},body);completed=true;}finally{if(!body.locked)await body.cancel().catch(()=>{});if(completed)await input.skip(remaining);}
    }
    await input.skip((512-size%512)%512);
  }}finally{input.reader.cancel().catch(()=>{});input.reader.releaseLock();}
}
