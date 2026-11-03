import {test} from 'node:test';
import assert from 'node:assert/strict';
import {beginEditionCreateFence, clearEditionCreateFence, readEditionCreateFence} from '../lib/edition-create-fence';

const actor='11111111-1111-4111-8111-111111111111', book='22222222-2222-4222-8222-222222222222', id='33333333-3333-4333-8333-333333333333';
function memory() {
  const data = new Map<string,string>();
  return {data, storage: {getItem:(key:string)=>data.get(key) ?? null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}} as Storage};
}
test('edition create fence stores only actor/book/request metadata and clears the exact pointer',()=>{
  const {data,storage}=memory(); const fence=beginEditionCreateFence(storage,actor,book,id);
  assert.deepEqual(readEditionCreateFence(storage,book),fence);
  assert.deepEqual(Object.keys(JSON.parse([...data.values()][0])).sort(),['actor','bookId','requestId','version']);
  assert.throws(()=>beginEditionCreateFence(storage,actor,book,id));
  clearEditionCreateFence(storage,fence);assert.equal(readEditionCreateFence(storage,book),null);
});
test('edition create fence never clears a replaced or malformed pointer',()=>{
  const {data,storage}=memory(); const fence=beginEditionCreateFence(storage,actor,book,id), name=[...data.keys()][0];
  data.set(name,'altered');assert.throws(()=>clearEditionCreateFence(storage,fence));assert.throws(()=>readEditionCreateFence(storage,book));assert.equal(data.get(name),'altered');
});
test('edition create fence fails before submission when session storage is unavailable',()=>{
  const {storage}=memory();storage.setItem=()=>{throw new Error('quota')};
  assert.throws(()=>beginEditionCreateFence(storage,actor,book,id),/No edition was sent/);
});
test('partial remove failure restores the exact marker when storage permits',()=>{
  const {data,storage}=memory();const fence=beginEditionCreateFence(storage,actor,book,id),name=[...data.keys()][0];
  storage.removeItem=(key:string)=>{data.delete(key);throw new Error('late failure')};
  assert.throws(()=>clearEditionCreateFence(storage,fence),/may not survive a reload/);
  assert.equal(data.get(name),fence.raw);
});
test('failed readback after removal attempts to restore the marker and never claims durability',()=>{
  const {data,storage}=memory();const fence=beginEditionCreateFence(storage,actor,book,id),name=[...data.keys()][0];
  let failRead=false;const get=storage.getItem.bind(storage);storage.removeItem=(key:string)=>{data.delete(key);failRead=true};
  storage.getItem=(key:string)=>{if(failRead){failRead=false;throw new Error('readback failed')}return get(key)};
  assert.throws(()=>clearEditionCreateFence(storage,fence),/may not survive a reload/);assert.equal(data.get(name),fence.raw);
});
test('permanent storage read failure after removal remains explicitly unconfirmed',()=>{
  const {data,storage}=memory();const fence=beginEditionCreateFence(storage,actor,book,id),name=[...data.keys()][0];
  let failed=false;const get=storage.getItem.bind(storage);storage.removeItem=(key:string)=>{data.delete(key);failed=true};storage.getItem=(key:string)=>{if(failed)throw new Error('offline');return get(key)};
  assert.throws(()=>clearEditionCreateFence(storage,fence),/may not survive a reload/);assert.equal(data.has(name),false);
});
