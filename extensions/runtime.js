import {createArgumentSchema} from '../argument-facts.js?v=1.0.1';
function text(value,max=8000){return String(typeof value==='string'?value:JSON.stringify(value)??'').slice(0,max);}
function rows(values){if(!Array.isArray(values))throw Error('擴充欄位需回傳陣列');return values.slice(0,200).map(row=>({label:text(row.label,160),value:text(row.value),section:row.section?text(row.section,80):'',path:row.path?text(row.path,240):''}));}
export function createExtensionHost(definitions=[]){
  const seen=new Set();const extensions=definitions.map(def=>{
    if(!def||typeof def.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(def.id)||seen.has(def.id))throw Error('分析擴充需要不重複的 id');seen.add(def.id);
    for(const name of ['eventFields','eventColor','analyze'])if(def[name]!==undefined&&typeof def[name]!=='function')throw Error(`${def.id}.${name} 必須是函式`);
    return {...def,title:text(def.title||def.id,160)};
  });
  return {
    argumentSchema:createArgumentSchema(extensions.filter(e=>e.argumentSchema!==undefined).map(e=>e.argumentSchema)),
    list:()=>extensions.map(e=>({id:e.id,title:e.title,analysis:!!e.analyze,eventFields:!!e.eventFields,eventColor:!!e.eventColor})),
    eventFields(event,context={}){const fields=[],errors=[];for(const e of extensions)if(e.eventFields){try{fields.push(...rows(e.eventFields(event,context)).map(row=>({...row,source:e.title})));}catch(error){errors.push({id:e.id,title:e.title,message:error.message});}}return {fields,errors};},
    eventColor(record,context={}){for(const e of extensions)if(e.eventColor){try{const result=e.eventColor(record,context);if(result&&/^#[0-9a-f]{6}$/i.test(result.fill))return {fill:result.fill,category:text(result.category||e.title,80)};}catch{}}return null;},
    async analyze(context){const result=[];for(const e of extensions)if(e.analyze){if(context.cancelled?.()){const error=new Error('分析已取消');error.name='AbortError';throw error;}
      try{const output=await e.analyze({...context,summary:structuredClone(context.summary),scope:structuredClone(context.scope)});result.push({id:e.id,title:e.title,status:'ok',summary:text(output?.summary||''),rows:rows(output?.rows||[])});}
      catch(error){if(error.name==='AbortError')throw error;result.push({id:e.id,title:e.title,status:'error',message:error.message});}
    }return result;}
  };
}
export async function loadExtensionHost(importer=()=>import('./custom.js')){
  try{return createExtensionHost((await importer()).default);}
  catch(error){const host=createExtensionHost([]);host.startupErrors=[{id:'extension-loader',title:'擴充載入失敗',message:error.message}];return host;}
}
