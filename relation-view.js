import {coreName} from './track-layout.js?v=0.4.0';
export function selectRelationLines(links,selected,tracks,{mode='compact',start=-Infinity,end=Infinity}={}){
  if(!selected||mode==='off')return [];
  const source=tracks[selected.trackId]||{},core=coreName(source.name)||coreName(source.tid);
  const gap=link=>Math.max(0,selected.ts-(link.record.ts+link.record.dur),link.record.ts-(selected.ts+selected.dur));
  const near=(a,b)=>gap(a)-gap(b)||Math.abs(a.record.ts-selected.ts)-Math.abs(b.record.ts-selected.ts);
  const strong=link=>link.relation.type==='flow'||link.relation.type==='symbol'&&link.relation.role!==link.otherRole;
  const ranked=[...links].sort((a,b)=>Number(strong(b))-Number(strong(a))||near(a,b));
  if(mode==='more')return ranked.slice(0,16);
  const chosen=ranked.filter(strong).slice(0,4);if(chosen.length>=4)return chosen;
  const addresses=ranked.filter(link=>{const target=tracks[link.record.trackId]||{},targetCore=coreName(target.name)||coreName(target.tid);return link.relation.type==='address'&&link.record.ts<=end&&link.record.ts+link.record.dur>=start&&String(target.pid)===String(source.pid)&&!(core&&targetCore&&core!==targetCore);});
  const before=addresses.find(link=>link.record.ts+link.record.dur<=selected.ts),after=addresses.find(link=>link.record.ts>=selected.ts+selected.dur);
  const addressChoices=[...new Set([before,after].filter(Boolean))];if(!addressChoices.length&&addresses.length)addressChoices.push(addresses[0]);
  return [...chosen,...addressChoices.slice(0,4-chosen.length)];
}
