// Rendering geometry only: interpolated points are never presented as events.
const number=new Intl.NumberFormat('en-US',{maximumSignificantDigits:5});
export function formatCounterValue(value){
  if(!Number.isFinite(value))return '—';if(value===0)return '0';
  const magnitude=Math.abs(value);
  return magnitude<.001||magnitude>=1e7?value.toExponential(3).replace(/(\.\d*?[1-9])0+e/,'$1e').replace(/\.0+e/,'e'):number.format(value);
}
export function counterPlot({rows=[],before=null,after=null,start,end}){
  if(!(end>start))return {points:[],min:null,max:null};
  const source=[...(before?[before]:[]),...rows,...(after?[after]:[])],points=[];
  const add=(ts,value,record=null)=>points.push({x:(ts-start)/(end-start),value,record,interpolated:!record});
  for(let i=0;i<source.length;i++){
    const record=source[i],prior=source[i-1];
    if(prior&&record.ts>prior.ts)for(const edge of [start,end])if(prior.ts<edge&&record.ts>edge){const f=(edge-prior.ts)/(record.ts-prior.ts);add(edge,prior.value*(1-f)+record.value*f);}
    if(record.ts>=start&&record.ts<=end)add(record.ts,record.value,record);
  }
  if(!points.length)return {points,min:null,max:null};
  let min=Infinity,max=-Infinity;for(const point of points){min=Math.min(min,point.value);max=Math.max(max,point.value);}
  const scale=Math.max(Math.abs(min),Math.abs(max),1e-300),range=max/scale-min/scale;
  for(const point of points)point.y=range?(point.value/scale-min/scale)/range:.5;
  return {points,min,max};
}
