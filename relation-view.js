import {coreName} from './track-layout.js?v=0.4.0';

export const relationRecordKey=record=>`${record.trackId}:${record.offset}`;
export const relationAssociations=link=>link.associations||[{relation:link.relation,otherRole:link.otherRole}];
export const relationKey=link=>JSON.stringify([link.relation.type,link.relation.key]);
const strong=link=>link.relation.type==='flow'||link.relation.type==='symbol'&&link.relation.role!==link.otherRole;

// Candidate groups describe the trace's labels; they do not infer dependencies.
export function groupRelationCandidates(links,tracks,processes={}){
  const groups=new Map();
  for(const link of links){const track=tracks[link.record.trackId]||{},core=coreName(track.name)||coreName(track.tid),id=JSON.stringify([String(track.pid),core||'']);
    if(!groups.has(id))groups.set(id,{id,label:`${processes[track.pid]||`Process ${track.pid}`} / ${core||'其他軌道'}`,links:[],trackIds:new Set()});
    const group=groups.get(id);group.links.push(link);group.trackIds.add(link.record.trackId);
  }
  return [...groups.values()].map(group=>({...group,trackCount:group.trackIds.size}));
}

export function selectRelationLines(links,selected,tracks,{mode='manual',start=-Infinity,end=Infinity,width=Infinity,focus=null}={}){
  if(!selected||mode==='off')return [];
  const visible=link=>link.record.ts<=end&&link.record.ts+link.record.dur>=start;
  const seen=new Set([relationRecordKey(selected)]),unique=[...links].sort((a,b)=>Number(strong(b))-Number(strong(a))).filter(link=>{const key=relationRecordKey(link.record);if(seen.has(key)||!visible(link))return false;seen.add(key);return true;});
  // Explicitly inspecting a candidate bypasses overview suppression, one line only.
  if(focus)return unique.filter(link=>relationRecordKey(link.record)===focus).slice(0,1);
  if(mode==='manual')return [];
  const pixels=record=>record.dur>0?record.dur/(end-start)*width:5;
  if(mode!=='more'&&(selected.ts>end||selected.ts+selected.dur<start||Number.isFinite(width)&&pixels(selected)<4))return [];
  const gap=link=>Math.max(0,selected.ts-(link.record.ts+link.record.dur),link.record.ts-(selected.ts+selected.dur));
  const near=(a,b)=>gap(a)-gap(b)||Math.abs(a.record.ts-selected.ts)-Math.abs(b.record.ts-selected.ts);
  const ranked=unique.sort((a,b)=>Number(strong(b))-Number(strong(a))||near(a,b));
  if(mode==='more')return ranked.slice(0,16);
  const candidates=ranked.filter(link=>strong(link)&&(!Number.isFinite(width)||pixels(link.record)>=4));
  const before=candidates.find(link=>link.record.ts<=selected.ts),after=candidates.find(link=>link.record.ts>selected.ts);
  return [...new Set([before,after,...candidates].filter(Boolean))].slice(0,2);
}
