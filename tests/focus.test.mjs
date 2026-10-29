import test from 'node:test';import assert from 'node:assert/strict';
import {replaceFocusedContent,trapDialogTab} from '../dist/focus.js';
function scene(keys){
  const page={active:null},control=(key,disabled=false)=>({disabled,key,getAttribute:()=>key,closest(){return this;},focus(){page.active=this;}});
  let children=keys.map(key=>control(key));const container={contains:node=>children.includes(node),querySelectorAll:()=>children,get children(){return children;},set innerHTML(next){children=next.map(item=>typeof item==='string'?control(item):control(item.key,item.disabled));page.active=null;}};
  return {page,container,control};
}
test('virtualized controls retain focus by identity across replacement and reordering',()=>{
  const {page,container}=scene(['group:a','pin:2','height:2']),original=container.children[1];
  replaceFocusedContent(container,['height:2','pin:2','group:a'],{active:original});assert.equal(page.active,container.children[1]);assert.notEqual(page.active,original);
});
test('removed or disabled virtualized controls return focus to the supplied workspace',()=>{
  for(const next of [[],[{key:'group:a',disabled:true}]]){const {page,container,control}=scene(['group:a']),fallback=control('timeline');replaceFocusedContent(container,next,{active:container.children[0],fallback});assert.equal(page.active,fallback);}
});
test('background updates never steal focus from outside the replaced controls',()=>{
  const {container,control}=scene(['trace:1']),external=control('search');let calls=0;external.focus=()=>calls++;replaceFocusedContent(container,['trace:2'],{active:external,fallback:external});assert.equal(calls,0);
});
test('stable focus identities accept quotes and punctuation without creating selectors',()=>{
  const key='group:process:"x]\\\n[odd', {page,container}=scene([key]);replaceFocusedContent(container,[key],{active:container.children[0]});assert.equal(page.active.key,key);
});

test('modal Tab wraps only at boundaries, skips unavailable controls, and preserves browser chords',()=>{
  const doc={activeElement:null},button=(id,options={})=>({id,tabIndex:0,getClientRects:()=>[{}],focus(){doc.activeElement=this;},...options}),first=button('first'),last=button('last'),controls=[button('disabled',{disabled:true}),first,button('hidden',{hidden:true}),button('option',{tabIndex:-1}),button('not rendered',{getClientRects:()=>[]}),last],dialog={ownerDocument:doc,querySelectorAll:()=>controls,contains:element=>controls.includes(element)};
  let prevented=false;const event=options=>({key:'Tab',preventDefault(){prevented=true;},...options});doc.activeElement=last;assert(trapDialogTab(dialog,event()));assert.equal(doc.activeElement,first);assert(prevented);doc.activeElement=first;assert(trapDialogTab(dialog,event({shiftKey:true})));assert.equal(doc.activeElement,last);
  doc.activeElement=first;assert.equal(trapDialogTab(dialog,event()),false);assert.equal(trapDialogTab(dialog,event({ctrlKey:true})),false);
});
