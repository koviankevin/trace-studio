// Present only fields explicitly supplied by the trace; do not infer a bottleneck.
const key=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
const fields=[
  ['Core ID',['coreid','coreidx'],'identity'],['Link ID',['linkid'],'identity'],['Tflite ID',['tfliteid','tfliteopid'],'identity'],['Op Group ID',['groupid'],'identity'],['Op ID',['opid','operationid'],'identity'],['Command ID',['commandid'],'identity'],['Subblock ID',['subblockid'],'identity'],['Request ID',['requestid'],'identity'],
  ['Block ID',['blockid'],'shape'],['Partition ID',['partitionid'],'shape'],['輸入 Shape',['inputshape','inshape','flowinputshape'],'shape'],['輸出 Shape',['outputshape','outshape','flowoutputshape'],'shape'],['Block Shape',['blockshape'],'shape'],['Block Offset',['blockoffset'],'shape'],
  ['DRAM 讀取',['dramreadbytes','dramread'],'memory'],['DRAM 寫入',['dramwritebytes','dramwrite'],'memory'],['LOCAL 讀取',['localreadbytes','localread'],'memory'],['LOCAL 寫入',['localwritebytes','localwrite'],'memory'],['CACHE 讀取',['cachereadbytes','cacheread'],'memory'],['CACHE 寫入',['cachewritebytes','cachewrite'],'memory'],['SRAM 讀取',['sramreadbytes','sramread'],'memory'],['SRAM 寫入',['sramwritebytes','sramwrite'],'memory'],
  ['Partition',['partitionstrategy','splitmode','softwarepartition'],'analysis'],['Split 依據',['partitionevidence','splitevidence'],'analysis'],['來源標示瓶頸',['bottleneck','criticalpath'],'analysis'],['來源建議',['suggestion','recommendation','optimizationhint'],'analysis'],['來源信心標記',['confidence','evidencelevel'],'analysis']
];
export function eventSummary(event){
  const entries=[];let visited=0;
  function visit(value,path,depth){if(!value||typeof value!=='object'||depth>5||visited>=2048)return;
    for(const [name,child]of Object.entries(value)){if(++visited>2048)return;const next=[...path,name];
      entries.push({leaf:key(name),suffixes:[key(next.slice(-2).join('')),key(next.slice(-3).join(''))],path:next.join('.'),value:child});
      if(!Array.isArray(child)&&child&&typeof child==='object')visit(child,next,depth+1);
    }
  }visit(event.args,['args'],0);
  return fields.flatMap(([label,aliases,section])=>{
    const found=entries.find(e=>aliases.includes(e.leaf)||e.suffixes.some(suffix=>aliases.includes(suffix)));
    if(!found||found.value===null||found.value===undefined)return [];
    let value=typeof found.value==='string'?found.value:JSON.stringify(found.value);
    if(value.length>1200)value=value.slice(0,1200)+'…';
    if(/bytes$/.test(found.leaf)&&typeof found.value==='number')value+=' B';
    return [{label,value,path:found.path,section}];
  });
}
