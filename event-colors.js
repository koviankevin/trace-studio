import {hash} from './core.js?v=0.4.0';
const colors={
  compute:['#adc7e8','#57799d','計算'],transfer:['#acd2b8','#57816a','資料搬移'],wait:['#ebd092','#9b813f','等待／同步'],frame:['#cbb9e2','#806799','框架'],script:['#b8d7e1','#59818e','Script'],render:['#e5bda8','#a17d68','Rendering'],network:['#e1c6a1','#92784e','Network']
};
const other=['#bfcbb2','#d4c5d6','#b7d3cf','#d7cfb1','#c3cbe0','#dcbfc2'];
const otherDark=['#77856b','#8e7490','#6c938c','#958c68','#7784a2','#9d7b7f'];
const cache=new Map();
const inks=new Map();
export function readableEventText(fill){
  if(inks.has(fill))return inks.get(fill);
  if(!/^#[0-9a-f]{6}$/i.test(fill))return '#000000';
  const rgb=fill.slice(1).match(/../g).map(channel=>{const value=parseInt(channel,16)/255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;});
  const luminance=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722,text=(luminance+.05)/.05>=1.05/(luminance+.05)?'#000000':'#ffffff';
  inks.set(fill,text);if(inks.size>256)inks.delete(inks.keys().next().value);return text;
}
export function eventColor(record,dark=false){
  const name=String(record.label||''),cacheKey=`${dark?'d':'l'}:${name}`;if(cache.has(cacheKey))return cache.get(cacheKey);let type;
  if(/stall|wait|barrier|semaphore|mutex|fence|sync/i.test(name))type='wait';
  else if(/frame|commit|swapbuffers/i.test(name))type='frame';
  else if(/conv|gemm|matmul|compute|activation|pool/i.test(name))type='compute';
  else if(/\bdma\b|memcpy|transfer|copy|\bload\b|\bstore\b/i.test(name))type='transfer';
  else if(/request|resource|network|fetch/i.test(name))type='network';
  else if(/script|function|v8|react|reconcile|performwork|runtask/i.test(name))type='script';
  else if(/layout|paint|raster|composite/i.test(name))type='render';
  const palette=colors[type],fill=palette?palette[dark?1:0]:(dark?otherDark:other)[hash(name)%other.length],result={fill,text:readableEventText(fill),category:palette?palette[2]:'其他'};
  cache.set(cacheKey,result);if(cache.size>65536)cache.delete(cache.keys().next().value);return result;
}
