// Opt-in example for an internal AI. All results are explicitly labeled as sampling.
export default {
  id:'example-core',title:'CORE 擴充範例',
  eventFields(event){return event.args?.coreid!==undefined?[{label:'擴充核心名稱',value:`CORE${event.args.coreid}`}]:[];},
  eventColor(record){if(record.label?.startsWith('CUSTOM_'))return {fill:'#b6cde4',category:'自訂事件'};return null;},
  async analyze({scanIndex,readEvent}){
    let sampled=0,withFlow=0;
    for await(const record of scanIndex()){
      if(sampled>=10000)break;sampled++;
      if(readEvent(record).args?.linkid!==undefined)withFlow++;
    }
    return {summary:'只檢查分析範圍內前 10,000 筆索引事件；不是完整 Flow 或瓶頸分析。',rows:[{label:'抽樣事件數',value:sampled},{label:'樣本中含 Flow ID',value:withFlow}]};
  }
};
