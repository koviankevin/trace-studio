import test from 'node:test';import assert from 'node:assert/strict';
import {WorkspaceTabs} from '../dist/workspace-tabs.js';
test('closing chooses adjacent tabs and stays closed across inventory refresh and reload',()=>{
  const entries=['a','b','c'].map(id=>({id})),tabs=new WorkspaceTabs();tabs.sync(entries);
  assert.deepEqual(tabs.close('b'),['c','a']);tabs.sync(entries);assert.deepEqual(tabs.entries(entries),[entries[0],entries[2]]);
  const reload=new WorkspaceTabs(JSON.stringify(tabs.ids));reload.sync(entries);assert.deepEqual(reload.ids,['a','c']);reload.open('b');assert.deepEqual(reload.ids,['a','c','b']);
  reload.close('a');reload.close('b');reload.close('c');const empty=new WorkspaceTabs(JSON.stringify(reload.ids));empty.sync(entries);assert.deepEqual(empty.ids,[]);
});
test('workspace tolerates invalid storage and removed caches',()=>{const tabs=new WorkspaceTabs('broken');tabs.sync([{id:'a'}]);tabs.open('a');assert.deepEqual(tabs.ids,['a']);tabs.sync([]);assert.deepEqual(tabs.ids,[]);assert.deepEqual(tabs.close('unknown'),[]);});
