import {coreName} from './track-layout.js?v=0.13.0';
import {processName} from './event-labels.js?v=0.13.0';

export const relationRecordKey=record=>`${record.trackId}:${record.offset}`;
export const relationAssociations=link=>link.associations||[{relation:link.relation,otherRole:link.otherRole}];
export const relationKey=link=>JSON.stringify([link.relation.type,link.relation.key]);
export const isExplicitRelation=link=>link.relation.type==='flow'||link.relation.type==='symbol'&&((link.relation.role==='define'&&link.otherRole==='use')||(link.relation.role==='use'&&link.otherRole==='define'));
const strong=isExplicitRelation;

// Offscreen tracks have no queried hitbox. Mark the viewport boundary rather
// than inventing an event lane or loading every track just to draw a link.
export function relationEndpoint(record,{points,layout,scrollTop,height,width=Infinity,start=-Infinity,end=Infinity,toX}){
  if(!Number.isFinite(height)||height<=0)return null;
  const point=points.get(relationRecordKey(record));
  const edge=y=>y<0?'above':y>height?'below':null;
  const horizontal=record.ts+Math.max(0,record.dur||0)<start?'left':record.ts>end?'right':null;
  const clipped=(x,y)=>{const side=edge(y),pad=Math.min(8,height/2),padX=Math.min(8,width/2);return {x:Number.isFinite(width)?Math.max(padX,Math.min(width-padX,x)):x,y:side?Math.max(pad,Math.min(height-pad,y)):y,edge:side,...(horizontal?{horizontal}:{})};};
  if(point)return clipped(point.x,point.y);
  const row=layout.find(row=>row.track?.id===record.trackId||row.type==='group'&&row.collapsed&&row.trackIds.includes(record.trackId));
  if(!row)return null; // Filtered-out tracks have no trustworthy layout anchor.
  const top=row.y-scrollTop,bottom=top+row.h;
  if(horizontal||bottom<=0||top>=height)return clipped(toX(record.ts),top+row.h/2);
  if(row.type==='group'&&row.collapsed)return clipped(toX(record.ts),top+row.h/2);
  return null; // A visible aggregated event still needs zooming for an endpoint.
}

// Candidate groups describe the trace's labels; they do not infer dependencies.
export function groupRelationCandidates(links,tracks,processes={}){
  const groups=new Map();
  for(const link of links){const track=tracks[link.record.trackId]||{},core=coreName(track.name)||coreName(track.tid),id=JSON.stringify([String(track.pid),core||'']);
    if(!groups.has(id))groups.set(id,{id,label:`${processName(processes,track.pid)||`Process ${track.pid}`} / ${core||'其他軌道'}`,links:[],trackIds:new Set()});
    const group=groups.get(id);group.links.push(link);group.trackIds.add(link.record.trackId);
  }
  return [...groups.values()].map(group=>({...group,trackCount:group.trackIds.size}));
}

export function selectRelationLines(links,selected,tracks,{mode='manual',start=-Infinity,end=Infinity,width=Infinity,focus=null}={}){
  if(!selected||mode==='off')return [];
  const seen=new Set([relationRecordKey(selected)]),unique=[...links].sort((a,b)=>Number(strong(b))-Number(strong(a))).filter(link=>{const key=relationRecordKey(link.record);if(seen.has(key))return false;seen.add(key);return true;});
  // Explicitly inspecting a candidate bypasses overview suppression, one line only.
  if(focus)return unique.filter(link=>relationRecordKey(link.record)===focus).slice(0,1);
  if(mode==='manual')return [];
  const gap=link=>Math.max(0,selected.ts-(link.record.ts+link.record.dur),link.record.ts-(selected.ts+selected.dur));
  const near=(a,b)=>gap(a)-gap(b)||Math.abs(a.record.ts-selected.ts)-Math.abs(b.record.ts-selected.ts)||a.record.offset-b.record.offset;
  if(mode==='nearest'){
    const origin=tracks[selected.trackId];
    return unique.filter(link=>{if(link.record.trackId===selected.trackId)return false;const target=tracks[link.record.trackId];return !origin||!target||origin.tid===undefined||target.tid===undefined||String(origin.pid)!==String(target.pid)||String(origin.tid)!==String(target.tid);}).sort(near).slice(0,1);
  }
  const pixels=record=>record.dur>0?record.dur/(end-start)*width:5;
  if(mode!=='more'&&Number.isFinite(width)&&pixels(selected)<4)return [];
  const ranked=unique.sort((a,b)=>Number(strong(b))-Number(strong(a))||near(a,b));
  if(mode==='more')return ranked.slice(0,16);
  const candidates=ranked.filter(link=>strong(link)&&(!Number.isFinite(width)||pixels(link.record)>=4));
  const before=candidates.find(link=>link.record.ts<=selected.ts),after=candidates.find(link=>link.record.ts>selected.ts);
  return [...new Set([before,after,...candidates].filter(Boolean))].slice(0,2);
}
