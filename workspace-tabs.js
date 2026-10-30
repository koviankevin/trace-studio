// Open workspace tabs are independent of the persistent OPFS cache inventory.
export class WorkspaceTabs {
  constructor(raw=null){this.ids=null;try{const value=JSON.parse(raw);if(Array.isArray(value))this.ids=[...new Set(value.filter(id=>typeof id==='string'&&id.length<=100))];}catch{}}
  sync(entries){const available=new Set(entries.map(item=>item.id));this.ids=this.ids===null?entries.map(item=>item.id):this.ids.filter(id=>available.has(id));}
  open(id){this.ids??=[];if(!this.ids.includes(id))this.ids.push(id);}
  close(id){const index=this.ids?.indexOf(id)??-1;if(index<0)return [];this.ids.splice(index,1);return [...this.ids.slice(index),...this.ids.slice(0,index).reverse()];}
  entries(entries){const byId=new Map(entries.map(item=>[item.id,item]));return (this.ids||[]).map(id=>byId.get(id)).filter(Boolean);}
}
