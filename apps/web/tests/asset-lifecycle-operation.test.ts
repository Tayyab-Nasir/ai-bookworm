import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginAssetOperation, clearConfirmedAssetOperation, LegacyAssetOperationError, readAssetOperation } from '../lib/asset-lifecycle-operation';
const actor='aa910000-0000-4000-8000-000000000001', workspaceId='cc910000-0000-4000-8000-000000000001', assetId='dd910000-0000-4000-8000-000000000001';
const opId='ee910000-0000-4000-8000-000000000001', other='ee910000-0000-4000-8000-000000000002';
function store() { const m=new Map<string,string>(); return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v)},removeItem:(k:string)=>{m.delete(k)}}; }
test('lost replies keep the original operation and prevent competing mutation',()=>{
 const s=store(); const input={actor,workspaceId,assetId,action:'remove' as const,expectedDeletedAt:null,expectedRevision:null};
 const first=beginAssetOperation(s,input,()=>opId);
 assert.deepEqual(beginAssetOperation(s,input,()=>other),first);
 assert.throws(()=>beginAssetOperation(s,{...input,action:'restore',expectedDeletedAt:'2026-01-01T00:00:00Z'},()=>other));
 assert.throws(()=>beginAssetOperation(s,{...input,expectedRevision:other},()=>other));
 assert.throws(()=>clearConfirmedAssetOperation(s,first,null));
 assert.throws(()=>clearConfirmedAssetOperation(s,first,{assetId,operationId:other,action:'remove'}));
 assert.deepEqual(readAssetOperation(s,actor,workspaceId,assetId),first);
 clearConfirmedAssetOperation(s,first,{assetId,operationId:opId,action:'remove'});
 assert.equal(readAssetOperation(s,actor,workspaceId,assetId),null);
});
test('scope is isolated and storage failures prevent a request',()=>{
 const s=store(), input={actor,workspaceId,assetId,action:'remove' as const,expectedDeletedAt:null,expectedRevision:null};
 beginAssetOperation(s,input,()=>opId);
 assert.equal(readAssetOperation(s,other,workspaceId,assetId),null);
 assert.throws(()=>beginAssetOperation({getItem:()=>null,setItem:()=>{},removeItem:()=>{}},input,()=>other));
 assert.throws(()=>beginAssetOperation({getItem:()=>null,setItem:()=>{throw Error('quota')},removeItem:()=>{}},input,()=>other));
});
test('older saved requests remain intact and cannot be retried with invented revisions',()=>{
 const s=store();const key=`bookworm:asset-operation:v1:${actor}:${workspaceId}:${assetId}`;
 const legacy=JSON.stringify({actor,workspaceId,assetId,operationId:opId,action:'remove',expectedDeletedAt:null});
 s.setItem(key,legacy);
 assert.throws(()=>readAssetOperation(s,actor,workspaceId,assetId),LegacyAssetOperationError);
 assert.throws(()=>beginAssetOperation(s,{actor,workspaceId,assetId,action:'remove',expectedDeletedAt:null,expectedRevision:null},()=>other),LegacyAssetOperationError);
 assert.equal(s.getItem(key),legacy);
});
