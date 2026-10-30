// Synthetic illustration of generic core grouping; these timings and fields are not measurements.
export function hardwareDemo(){
  const events=[];
  const units=['CONTROL_LOAD','BUFFER_A_0','BUFFER_A_1','BUFFER_B_0','BUFFER_B_1','BUFFER_W','WEIGHT_LOAD','INPUT_LOAD_0','INPUT_LOAD_1','LOCAL_COPY','COMPUTE','ROUTE','ELEMENTWISE','POOL','TRANSFORM','OUTPUT_STORE','FRAME_DECODE','FRAME_DISPATCH'];
  for(let core=0;core<4;core++){
    const pid=100+core;events.push({ph:'M',pid,name:'process_name',args:{name:`CORE${core}`}});let tid=1;
    for(const unit of units)for(const work of [false,...(['BUFFER_A_0','BUFFER_A_1','BUFFER_B_0','BUFFER_B_1','BUFFER_W','COMPUTE','ELEMENTWISE','POOL','TRANSFORM','OUTPUT_STORE'].includes(unit)?[true]:[])]){
      const name=`CORE${core}_${unit}${work?' work':''}`;events.push({ph:'M',pid,tid,name:'thread_name',args:{name}});
      for(let flow=0;flow<80;flow++){
        const ts=flow*16667+core*1400+(tid%6)*370,dur=unit.startsWith('FRAME')?500:1200+(tid%7)*1700;
        const start=0x100000+flow*0x1000,output=unit==='COMPUTE';
        events.push({name:unit.startsWith('FRAME')?'FRAME':`${unit==='COMPUTE'?'CONV':'DMA'} · ${unit}`,ph:'X',pid,tid,ts,dur,cat:work?'work':'hardware',args:{coreid:core,linkid:flow,TfliteID:Math.floor(flow/4),GroupId:Math.floor(flow/4),opid:Math.floor(flow/4),commandid:1000+Math.floor(flow/8),blockid:flow%4,partitionid:core,input_shape:[12,12,64],output_shape:[10,10,32],block_shape:[10,10,32],block_offset:[0,0,core*32],address:`0x${start.toString(16)}`,MemoryRanges:{'Range Start 0':`0x${(start+(output?0:128)).toString(16)}`,'Range End 0':`0x${(start+(output?255:383)).toString(16)}`,'Size 0':256,'Space 0':`LOC_${output?'OUTPUT':'INPUT'}_LOCAL`},memory_traffic:{DRAM:{read_bytes:4096+tid*512,write_bytes:work?0:2048},LOCAL:{read_bytes:2048,write_bytes:1024}},demo:true}});
      }tid++;
    }
  }
  events.sort((a,b)=>(a.ts??-1)-(b.ts??-1));return {traceEvents:events,metadata:{description:'Synthetic four-core example. All timings, shapes and memory values are illustrative, not measured.',cores:4}};
}
