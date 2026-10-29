const natural=new Intl.Collator('en',{numeric:true,sensitivity:'base'});
export function coreName(name){
  const match=String(name||'').match(/(?:^|[\s/_[(:.-])(CORE|NPU|VPU|DSP|GPU|CPU|CORE)[\s_#:-]*(\d+)(?=$|[\s_./:[\]-])/i);
  return match?`${match[1].toUpperCase()}${Number(match[2])}`:null;
}
function compareTracks(a,b){
  const base=s=>s.replace(/(?:[\s_-]+work)$/i,'');
  return natural.compare(base(a.name),base(b.name))||Number(/(?:[\s_-]+work)$/i.test(a.name))-Number(/(?:[\s_-]+work)$/i.test(b.name))||natural.compare(a.name,b.name)||a.id-b.id;
}
export function trackName(track){return track.name===`Thread ${track.tid}`?String(track.tid):track.name;}
function groupProcesses(tracks,processes={},prefix=''){
  const processesById=new Map();
  for(const track of tracks){if(!track.count)continue;const key=String(track.pid);if(!processesById.has(key))processesById.set(key,[]);processesById.get(key).push(track);}
  const roots=[];
  for(const [pid,members]of processesById){
    const buckets=new Map();for(const track of members){const key=coreName(track.name)||'';if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(track);}
    const root={id:`${prefix}process:${pid}`,label:processes[pid]||`Process ${pid}`,pid,kind:'process',tracks:members,children:[]};
    if(buckets.size>1&&[...buckets.keys()].some(Boolean)){
      for(const [core,children]of [...buckets].sort(([a],[b])=>a===''?1:b===''?-1:natural.compare(a,b))){
        root.children.push({id:`${prefix}core:${pid}:${core||'other'}`,label:core||'其他軌道',pid,kind:'core',tracks:children,children:[...children].sort(compareTracks)});
      }
    }else root.children=[...members].sort(compareTracks);
    roots.push(root);
  }
  return roots.sort((a,b)=>natural.compare(a.label,b.label)||natural.compare(a.pid,b.pid));
}
export function groupTracks(tracks,processes={}){
  const curves=tracks.filter(t=>t.count&&t.kind==='counter'),segments=tracks.filter(t=>t.kind!=='counter');
  const roots=groupProcesses(segments,processes);
  if(curves.length)roots.push({id:'numeric-curves',label:'數值曲線',pid:null,kind:'counter-group',tracks:curves,children:groupProcesses(curves,processes,'counter-')});
  return roots;
}
export function allGroups(roots){const result=[];function visit(node){if(!node.children)return;result.push(node);for(const child of node.children)visit(child);}roots.forEach(visit);return result;}
export function defaultCollapsed(roots){
  const result=new Set();for(const root of roots){
    // Show multiple processes/cores as a useful overview before expanding details.
    if(roots.length>1)result.add(root.id);
    else for(const child of root.children)if(child.children)result.add(child.id);
    if(roots.length===1&&root.children.every(child=>!child.children)&&root.tracks.length>16)result.add(root.id);
  }return result;
}
export function trackHeight(track,{density='compact',expanded=false,lanes=1}={}){
  if(expanded)return density==='compact'?160:204;
  if(density!=='compact')return track.kind==='counter'?94:98;
  if(track.kind==='counter')return 48;
  return 14+Math.max(1,Math.min(4,lanes))*18;
}
export function makeTrackLayout(roots,{collapsed=new Set(),filter='',pins=new Set(),expanded=new Set(),density='compact',lanes=new Map()}={}){
  const words=filter.toLowerCase().split(',').map(x=>x.trim()).filter(Boolean),rows=[];let y=0;
  const all=roots.flatMap(root=>root.tracks),byId=new Map(all.map(t=>[t.id,t]));
  const matches=(t,path=[])=>!words.length||words.some(word=>`${t.name} ${coreName(t.name)||''} ${t.pid} ${t.tid} ${path.map(g=>g.label).join(' ')}`.toLowerCase().includes(word));
  function push(row,h){rows.push({...row,y,h});y+=h;}
  function leaf(track,path,depth){
    let name=trackName(track);const core=coreName(name);
    if(core&&path.some(group=>coreName(group.label)===core)){
      name=name.replace(new RegExp(`^${core.replace(/(\D+)(\d+)/,'$1[ _#:-]*$2')}[ _:/-]+`,'i'),'')||track.name;
    }
    push({id:`track:${track.id}`,type:'track',track,depth,path:path.map(g=>g.id),displayName:name},trackHeight(track,{density,expanded:expanded.has(track.id),lanes:lanes.get(track.id)||1}));
  }
  function trailFor(id,groups=roots,path=[]){for(const group of groups)if(group.tracks.some(t=>t.id===id)){const trail=[...path,group];return trailFor(id,group.children.filter(t=>t.children),trail)||trail;}return null;}
  for(const id of pins){const t=byId.get(id);if(t&&matches(t,trailFor(id)||[]))leaf(t,[],0);}
  function visit(group,path,depth){
    const trail=[...path,group],members=group.tracks.filter(t=>!pins.has(t.id)&&matches(t,trail));if(!members.length)return;
    const isCollapsed=!words.length&&collapsed.has(group.id);
    push({id:group.id,type:'group',group,depth,collapsed:isCollapsed,trackIds:members.map(t=>t.id)},density==='compact'?32:38);
    if(isCollapsed)return;
    for(const child of group.children){if(child.children)visit(child,trail,depth+1);else if(!pins.has(child.id)&&matches(child,trail))leaf(child,trail,depth+1);}
  }
  roots.forEach(root=>visit(root,[],0));return {rows,height:y};
}
export function revealTrack(roots,collapsed,trackId){
  function visit(group){if(!group.tracks.some(t=>t.id===trackId))return;collapsed.delete(group.id);for(const child of group.children)if(child.children)visit(child);}
  roots.forEach(visit);
}

// Collapsed groups use existing block summaries only: no raw events or disk reads.
// This is a coarse activity overview, never an exact event count or utilization.
export function summarizeGroups(trace,groups,start,end,width){
  const columns=Math.max(1,Math.min(240,Math.ceil(width/4))),span=Math.max(.001,end-start),result=[];
  for(const group of groups){const bins=new Uint32Array(columns);
    for(const trackId of group.trackIds){const track=trace.tracks[trackId];if(!track)continue;
      for(const id of track.blocks){const block=trace.blocks[id];if(block.start>end||block.end<start)continue;
        for(const r of block.summary){if(r.ts>end||r.ts+Math.max(0,r.dur)<start)continue;
          const left=Math.max(0,Math.min(columns-1,Math.floor((Math.max(start,r.ts)-start)/span*columns)));
          const right=Math.max(left,Math.min(columns-1,Math.floor((Math.min(end,r.ts+Math.max(0,r.dur))-start)/span*columns)));
          for(let x=left;x<=right;x++)bins[x]=Math.min(0xffffffff,bins[x]+(r.n||1));
        }
      }
    }result.push({id:group.id,bins:Array.from(bins)});
  }return result;
}
