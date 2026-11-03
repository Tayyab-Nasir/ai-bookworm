import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
const output=await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import Removed from './apps/web/components/RemovedAssets';
const root=createRoot(document.getElementById('root')); window.clear=()=>root.render(null); window.render=()=>root.render(React.createElement(Removed,{api:window.api,scope:{actor:window.actor,begin:()=>{const n=window.epoch;return ()=>window.epoch===n}},workspaceId:window.workspace,canEdit:window.edit,current:()=>window.edit,revision:window.rev,onChanged:async()=>{window.changed++;if(window.refreshFail)throw Error('refresh failed')}}));`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic'});
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||'msedge'});
test.after(()=>browser.close());
const actor='11111111-1111-4111-8111-111111111111', workspace='22222222-2222-4222-8222-222222222222', asset='33333333-3333-4333-8333-333333333333', date='2026-11-03T01:00:00.000Z';
async function fixture() {
 const page=await browser.newPage(); page.setDefaultTimeout(5000);
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'})); await page.goto('http://127.0.0.1/');
 await page.evaluate(({actor,workspace,asset,date})=>{
  Object.assign(window,{actor,workspace,asset,date,epoch:0,rev:0,edit:true,changed:0,attempts:[],lost:true,receipt:null});
  window.api={listRemovedAssets:async()=>({assets:[{id:asset,workspace_id:workspace,name:'A manuscript.pdf',deleted_at:date,lifecycle_revision:null,hasRecordedChecksum:true}]}),getAssetLifecycleStatus:async()=>({operation:window.receipt}),
    restoreAssetLifecycle:async(id,body)=>{window.attempts.push(body.operationId);window.receipt={assetId:id,operationId:body.operationId,action:'restore',expectedDeletedAt:date,expectedRevision:body.expectedRevision,outcome:'committed',committedAt:date,closedAt:null}; if(window.lost){window.lost=false;throw Error('lost reply')} return {assetId:id,operationId:body.operationId,action:'restore',expectedRevision:body.expectedRevision,replayed:true}},
    closeAssetLifecycle:async(id,body)=>({operation:{assetId:id,operationId:body.operationId,action:body.action,expectedDeletedAt:body.expectedDeletedAt,expectedRevision:body.expectedRevision,outcome:'closed',committedAt:null,closedAt:date}}),
    removeAssetLifecycle:async()=>{throw Error('unexpected')} };
 },{actor,workspace,asset,date});
 await page.addScriptTag({content:output.outputFiles[0].text}); await page.evaluate(()=>window.render());
 await expect(page.getByRole('button',{name:'Restore',exact:true})).toBeVisible();return page;
}
test('lost restore reply persists identity and status recovery does not repeat the mutation',async()=>{
 const page=await fixture();try {
 await page.getByRole('button',{name:'Restore',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('could not be confirmed');
 await expect(page.getByText('Requests needing confirmation on this tab')).toBeVisible();
 await page.evaluate(()=>window.clear()); await expect(page.getByText('Removed files')).toHaveCount(0); await page.evaluate(()=>window.render());
 await expect(page.getByText('Requests needing confirmation on this tab')).toBeVisible();
 await page.getByRole('button',{name:'Check status'}).click();
 await expect(page.getByRole('status')).toContainText('Restoration confirmed');
 assert.equal(await page.evaluate(()=>window.attempts.length),1);
 assert.equal(await page.evaluate(()=>sessionStorage.length),0);
 } finally {await page.close()}
});

test('close fences an unconfirmed request and never claims restoration',async()=>{
 const page=await fixture();try {
 await page.getByRole('button',{name:'Restore',exact:true}).click(); await expect(page.getByRole('alert')).toBeVisible();
 await page.evaluate(()=>{window.receipt=null}); page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Close unconfirmed request'}).click();
 await expect(page.getByRole('status')).toContainText('original request was closed');
 await expect(page.getByText('Restoration confirmed')).toHaveCount(0);
 assert.equal(await page.evaluate(()=>sessionStorage.length),0);
 } finally {await page.close()}
});

test('different microsecond receipt cannot clear saved operation',async()=>{
 const page=await fixture();try {
 await page.getByRole('button',{name:'Restore',exact:true}).click(); await expect(page.getByRole('alert')).toBeVisible();
 await page.evaluate(()=>{window.receipt.expectedDeletedAt='2026-11-03T01:00:00.000001Z'});
 await page.getByRole('button',{name:'Check status'}).click();
 await expect(page.getByRole('alert')).toContainText('could not be confirmed');
 assert.equal(await page.evaluate(()=>sessionStorage.length),1);
 } finally {await page.close()}
});

test('a different lifecycle revision cannot clear saved operation',async()=>{
 const page=await fixture();try {
 await page.getByRole('button',{name:'Restore',exact:true}).click(); await expect(page.getByRole('alert')).toBeVisible();
 await page.evaluate(()=>{window.receipt.expectedRevision='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
 await page.getByRole('button',{name:'Check status'}).click();
 await expect(page.getByRole('alert')).toContainText('could not be confirmed');
 assert.equal(await page.evaluate(()=>sessionStorage.length),1);
 } finally {await page.close()}
});

test('malformed terminal receipt cannot clear saved operation',async()=>{
 const page=await fixture();try {
 await page.getByRole('button',{name:'Restore',exact:true}).click(); await expect(page.getByRole('alert')).toBeVisible();
 await page.evaluate(()=>{window.receipt.committedAt=null;window.receipt.closedAt=window.date});
 await page.getByRole('button',{name:'Check status'}).click();
 await expect(page.getByRole('alert')).toContainText('could not be confirmed');
 assert.equal(await page.evaluate(()=>sessionStorage.length),1);
 } finally {await page.close()}
});

test('calendar-invalid receipt cannot clear saved operation',async()=>{
 const page=await fixture();try {
 await page.getByRole('button',{name:'Restore',exact:true}).click(); await expect(page.getByRole('alert')).toBeVisible();
 await page.evaluate(()=>{window.receipt.committedAt='2026-02-30T00:00:00Z'});
 await page.getByRole('button',{name:'Check status'}).click();
 await expect(page.getByRole('alert')).toContainText('could not be confirmed');
 assert.equal(await page.evaluate(()=>sessionStorage.length),1);
 } finally {await page.close()}
});

test('malformed retry receipt cannot clear saved operation',async()=>{
 const page=await fixture();try {
 await page.getByRole('button',{name:'Restore',exact:true}).click(); await expect(page.getByRole('alert')).toBeVisible();
 await page.evaluate(()=>{window.receipt=null;window.api.restoreAssetLifecycle=async(id,body)=>({assetId:id,operationId:body.operationId,action:'restore'})});
 await page.getByRole('button',{name:'Retry original request'}).click();
 await expect(page.getByRole('alert')).toContainText('could not be confirmed');
 assert.equal(await page.evaluate(()=>sessionStorage.length),1);
 } finally {await page.close()}
});

test('a refresh failure after confirmation does not claim the request is pending',async()=>{
 const page=await fixture();try {
 await page.getByRole('button',{name:'Restore',exact:true}).click(); await expect(page.getByRole('alert')).toBeVisible();
 await page.evaluate(()=>{window.refreshFail=true});
 await page.getByRole('button',{name:'Check status'}).click();
 await expect(page.getByRole('status')).toContainText('Restoration confirmed');
 await expect(page.getByRole('alert')).toContainText('request was confirmed, but the file list could not refresh');
 assert.equal(await page.evaluate(()=>sessionStorage.length),0);
 } finally {await page.close()}
});
test('pending restore can only retry the same ID and scope change suppresses stale success',async()=>{
 const page=await fixture();try {
 await page.getByRole('button',{name:'Restore',exact:true}).click(); await expect(page.getByRole('alert')).toBeVisible();
 await page.evaluate(()=>{window.receipt=null});
 await page.getByRole('button',{name:'Retry original request'}).click(); await expect(page.getByRole('status')).toContainText('Restoration confirmed');
 assert.equal(await page.evaluate(()=>new Set(window.attempts).size),1);
 await page.evaluate(()=>{window.api.getAssetLifecycleStatus=()=>new Promise(resolve=>window.resolve=resolve);window.edit=true;window.rev++;window.render()});
 await page.getByRole('button',{name:'Restore',exact:true}).click();
 await page.evaluate(()=>{window.edit=false;window.epoch++;window.render();window.resolve({operation:null})});
 await expect(page.getByText('Restoration confirmed')).toHaveCount(0);
 assert.equal(await page.evaluate(()=>sessionStorage.length),1);
 } finally {await page.close()}
});

test('an asset without a recorded checksum does not start a restore',async()=>{
 const page=await fixture();try {
 await page.evaluate(()=>{window.api.listRemovedAssets=async()=>({assets:[{id:window.asset,workspace_id:window.workspace,name:'Pending upload',deleted_at:window.date,lifecycle_revision:null,hasRecordedChecksum:false}]});window.rev++;window.render()});
 await expect(page.getByText('Restore unavailable: no usable file checksum was recorded.')).toBeVisible();
 await expect(page.getByRole('button',{name:'Restore',exact:true})).toHaveCount(0);
 assert.equal(await page.evaluate(()=>window.attempts.length),0);
 assert.equal(await page.evaluate(()=>sessionStorage.length),0);
 } finally {await page.close()}
});

test('older saved request is preserved and shown with recovery guidance',async()=>{
 const page=await fixture();try {
 await page.evaluate(()=>{
  const key=`bookworm:asset-operation:v1:${window.actor}:${window.workspace}:${window.asset}`;
  const old={actor:window.actor,workspaceId:window.workspace,assetId:window.asset,operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',action:'remove',expectedDeletedAt:null};
  sessionStorage.setItem(key,JSON.stringify(old));window.rev++;window.render();
 });
 await expect(page.getByRole('alert')).toContainText('older file request cannot be retried safely');
 assert.equal(await page.evaluate(()=>sessionStorage.length),1);
 assert.equal(await page.evaluate(()=>window.attempts.length),0);
 await expect(page.getByRole('button',{name:'Retry original request'})).toHaveCount(0);
 } finally {await page.close()}
});

test('an older request blocks only its asset while unrelated requests remain recoverable',async()=>{
 const page=await fixture();try {
 await page.evaluate(()=>{
  const other='55555555-5555-4555-8555-555555555555';
  const key=id=>`bookworm:asset-operation:v1:${window.actor}:${window.workspace}:${id}`;
  sessionStorage.setItem(key(window.asset),JSON.stringify({actor:window.actor,workspaceId:window.workspace,assetId:window.asset,operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',action:'remove',expectedDeletedAt:null}));
  sessionStorage.setItem(key(other),JSON.stringify({actor:window.actor,workspaceId:window.workspace,assetId:other,operationId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',action:'remove',expectedDeletedAt:null,expectedRevision:null}));
  window.api.listRemovedAssets=async()=>({assets:[{id:window.asset,workspace_id:window.workspace,name:'Old file',deleted_at:window.date,lifecycle_revision:null,hasRecordedChecksum:true},{id:other,workspace_id:window.workspace,name:'Other file',deleted_at:window.date,lifecycle_revision:null,hasRecordedChecksum:true}]});
  window.rev++;window.render();
 });
 await expect(page.getByRole('alert')).toContainText('older file request cannot be retried safely');
 await expect(page.getByText('Requests needing confirmation on this tab')).toBeVisible();
 await expect(page.getByRole('button',{name:'Retry original request'})).toHaveCount(1);
 await expect(page.getByRole('button',{name:'Restore'})).toHaveCount(2);
 const controls=page.getByRole('button',{name:'Restore'}); await expect(controls.nth(0)).toBeDisabled();
 assert.equal(await page.evaluate(()=>sessionStorage.length),2);
 } finally {await page.close()}
});
