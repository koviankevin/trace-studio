import {normalizeIdentifier} from './argument-facts.js?v=0.4.0';
export function parseTfliteSelection(value,maxIds=256){
  if(value===undefined||value===null||String(value).trim()==='')return [];
  if(!Number.isInteger(maxIds)||maxIds<1||maxIds>4096)throw Error('無效的 ID 數量上限');
  const text=Array.isArray(value)?null:String(value);if(text!==null&&text.length>4096)throw Error('TfliteID 選取內容過長');
  const tokens=text===null?value:text.replace(/(\d)\s*-\s*(\d)/g,'$1-$2').split(/[,;，；\s]+/).filter(Boolean);
  if(tokens.length>1024)throw Error('TfliteID 選取內容過長');const ids=new Set();
  const add=raw=>{const id=normalizeIdentifier(raw);if(id===null)throw Error('請輸入有效的 TfliteID，例如 7, 8, 12-15');ids.add(id);if(ids.size>maxIds)throw Error(`最多選擇 ${maxIds} 個 TfliteID；整圖比較可留空。`);};
  for(const token of tokens){const range=typeof token==='string'&&token.match(/^(\d+)-(\d+)$/);if(range){const start=BigInt(range[1]),end=BigInt(range[2]);if(end<start||end-start+1n>BigInt(maxIds))throw Error('ID 範圍無效或過大');for(let id=start;id<=end;id++)add(String(id));}else add(token);}
  return [...ids];
}
