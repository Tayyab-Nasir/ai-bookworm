import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
const [bundle] = await Promise.all([build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import {ApiClientError} from '@bookworm/api-client'; window.TestApiClientError=ApiClientError; import App from './apps/web/components/InvitationAcceptance'; const root=createRoot(document.getElementById('root')); window.mount=()=>root.render(React.createElement(App)); window.unmount=()=>root.render(null);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/^(\.\/api|next\/link)$/},a=>({path:a.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({resolveDir:process.cwd(),contents:a.path==='./api'?`export const apiClient=(actor)=>({acceptWorkspaceInvitation:token=>window.acceptCall(actor,token),checkWorkspaceInvitation:token=>window.statusCall(actor,token)})`:`import React from 'react';export default function Link({children,...props}){return React.createElement('a',props,children)}`}))}}]})]);
const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<html><body><div id="root"></div></body></html>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||'chrome'});after(async()=>{await browser.close();await new Promise(r=>server.close(r))});
const ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222',ws:'33333333-3333-4333-8333-333333333333'};
async function fixture(){const page=await browser.newPage();page.setDefaultTimeout(6000);await page.goto(`http://127.0.0.1:${server.address().port}/team/accept`);await page.evaluate(ids=>{window.ids=ids;window.actor=ids.a;window.calls=[];window.checks=[];window.sessionFail=false;window.fetch=async url=>{if(String(url)!=='/api/auth/session')throw Error('unexpected fetch');if(window.sessionFail)return new Response('',{status:503});const observed=window.actor;if(window.holdSession){window.holdSession=false;await new Promise(r=>window.releaseSession=r)}return Response.json({user:{id:observed,email:observed===ids.a?'a@example.test':'b@example.test'}})};window.acceptCall=async(actor,token)=>{window.calls.push({actor,token,actual:window.actor});if(actor&&actor!==window.actor)throw Error('account changed');if(window.hold)await new Promise(r=>window.release=r);if(window.failCode)throw new window.TestApiClientError(window.failCode,'denied','Invitation does not belong to this account','synthetic');if(window.fail)throw Error('lost response');return {workspaceId:ids.ws,organizationId:ids.ws,role:'editor',status:'active'}};window.statusCall=async(actor,token)=>{window.checks.push({actor,token});const result=window.statusResult??{viewerId:actor,state:'not_confirmed'};if(window.holdStatus){window.holdStatus=false;await new Promise(r=>window.releaseStatus=r)}if(window.statusFail)throw Error('status unavailable');return result};sessionStorage.setItem('bookworm:invitationToken','synthetic-token-not-private');},ids);await page.addScriptTag({content:bundle.outputFiles[0].text});await page.evaluate(()=>window.mount());await page.getByText('a@example.test').waitFor();return page;}
test('silent account switch does not submit invitation under a different identity',async()=>{const p=await fixture();try{await p.evaluate(()=>window.actor=window.ids.b);await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.waitForTimeout(600);assert.equal(await p.evaluate(()=>window.calls.length),0);assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),null)}finally{await p.close()}});
test('normal acceptance remains usable and bound to verified identity',async()=>{const p=await fixture();try{await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.getByText('You joined the workspace as editor.').waitFor();assert.deepEqual(await p.evaluate(()=>window.calls.map(c=>c.actor)),[ids.a]);assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),ids.ws)}finally{await p.close()}});
test('late acceptance after account switch never writes new account workspace',async()=>{const p=await fixture();try{await p.evaluate(()=>window.hold=true);await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.waitForFunction(()=>typeof window.release==='function');await p.evaluate(()=>{window.actor=window.ids.b;window.dispatchEvent(new Event('focus'));window.release()});await p.waitForTimeout(500);assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),null);assert.equal(await p.getByText('You joined the workspace as editor.').count(),0)}finally{await p.close()}});
test('lost response preserves the token and does not retry automatically',async()=>{const p=await fixture();try{await p.evaluate(()=>window.fail=true);await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.getByText(/may have been accepted/).waitFor();assert.equal(await p.evaluate(()=>window.calls.length),1);assert.equal(await p.evaluate(()=>sessionStorage.getItem('bookworm:invitationToken')),'synthetic-token-not-private');assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),null);assert.equal(await p.getByRole('button',{name:'Accept and join workspace'}).count(),0)}finally{await p.close()}});
test('late response after silent account switch cannot publish old workspace',async()=>{const p=await fixture();try{await p.evaluate(()=>window.hold=true);await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.waitForFunction(()=>typeof window.release==='function');await p.evaluate(()=>{window.actor=window.ids.b;window.release()});await p.getByText(/may have been accepted/).waitFor();assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),null);assert.equal(await p.getByText('You joined the workspace as editor.').count(),0)}finally{await p.close()}});
test('unmount during request does not write workspace or remove token',async()=>{const p=await fixture();try{await p.evaluate(()=>window.hold=true);await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.waitForFunction(()=>typeof window.release==='function');await p.evaluate(async()=>{window.unmount();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));window.release()});await p.waitForTimeout(500);assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),null);assert.equal(await p.evaluate(()=>sessionStorage.getItem('bookworm:invitationToken')),'synthetic-token-not-private')}finally{await p.close()}});
test('a replacement invitation token is never removed by an older completion',async()=>{const p=await fixture();try{await p.evaluate(()=>window.hold=true);await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.waitForFunction(()=>typeof window.release==='function');await p.evaluate(()=>{sessionStorage.setItem('bookworm:invitationToken','synthetic-newer-token');window.release()});await p.getByText('You joined the workspace as editor.').waitFor();assert.equal(await p.evaluate(()=>sessionStorage.getItem('bookworm:invitationToken')),'synthetic-newer-token')}finally{await p.close()}});
test('definitive wrong-account rejection remains actionable',async()=>{const p=await fixture();try{await p.evaluate(()=>window.failCode=403);await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.getByText('Invitation does not belong to this account').waitFor();assert.equal(await p.getByText(/may have been accepted/).count(),0);assert.equal(await p.getByRole('button',{name:'Accept and join workspace'}).count(),1);assert.equal(await p.evaluate(()=>sessionStorage.getItem('bookworm:invitationToken')),'synthetic-token-not-private')}finally{await p.close()}});
test('the actor-bound request blocks a switch after preflight reads the old identity',async()=>{const p=await fixture();try{await p.evaluate(()=>window.holdSession=true);await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.waitForFunction(()=>typeof window.releaseSession==='function');await p.evaluate(()=>{window.actor=window.ids.b;window.releaseSession()});await p.getByText(/may have been accepted/).waitFor();assert.deepEqual(await p.evaluate(()=>window.calls.map(c=>({actor:c.actor,actual:c.actual}))),[{actor:ids.a,actual:ids.b}]);assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),null)}finally{await p.close()}});
test('accepted workspace and role disappear after a later account switch',async()=>{const p=await fixture();try{await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.getByText('You joined the workspace as editor.').waitFor();await p.evaluate(()=>{window.actor=window.ids.b;window.dispatchEvent(new Event('focus'))});await p.getByText('This invitation link is missing its secure token.',{exact:false}).waitFor();assert.equal(await p.getByText('You joined the workspace as editor.').count(),0);assert.equal(await p.getByRole('link',{name:'Open the team workspace'}).count(),0)}finally{await p.close()}});
test('session failure hides prior actor and preserves invitation',async()=>{const p=await fixture();try{await p.evaluate(()=>{window.sessionFail=true;window.dispatchEvent(new Event('focus'))});await p.getByRole('link',{name:'Sign in to continue'}).waitFor();assert.equal(await p.getByText('a@example.test').count(),0);assert.equal(await p.getByRole('button',{name:'Accept and join workspace'}).count(),0);assert.equal(await p.evaluate(()=>sessionStorage.getItem('bookworm:invitationToken')),'synthetic-token-not-private')}finally{await p.close()}});
test('confirmed acceptance survives disabled local preference storage',async()=>{const p=await fixture();try{await p.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(this===localStorage)throw Error('storage disabled');return original.call(this,k,v)}});await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.getByText('You joined the workspace as editor.').waitFor();assert.equal(await p.getByText(/may have been accepted/).count(),0)}finally{await p.close()}});
test('confirmed acceptance survives session token cleanup failure',async()=>{const p=await fixture();try{await p.evaluate(()=>{const original=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){if(this===sessionStorage)throw Error('storage disabled');return original.call(this,k)}});await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.getByText('You joined the workspace as editor.').waitFor();assert.equal(await p.getByText(/may have been accepted/).count(),0)}finally{await p.close()}});
test('lost acceptance response can be recovered after remount with the current role',async()=>{const p=await fixture();try{await p.evaluate(()=>window.fail=true);await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.getByText(/may have been accepted/).waitFor();await p.evaluate(async()=>{window.unmount();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));window.statusResult={viewerId:window.ids.a,state:'accepted',workspaceId:window.ids.ws,role:'reviewer'};window.mount()});await p.getByText('Invitation accepted. Your current role is reviewer.').waitFor();assert.equal(await p.evaluate(()=>window.calls.length),1);assert.equal(await p.evaluate(()=>sessionStorage.getItem('bookworm:invitationToken')),null);assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),ids.ws)}finally{await p.close()}});
test('acceptance without current access never reveals a workspace link',async()=>{const p=await fixture();try{await p.evaluate(()=>window.statusResult={viewerId:window.ids.a,state:'accepted_unavailable'});await p.getByRole('button',{name:'Check invitation status'}).click();await p.getByText(/workspace access is not currently available/).waitFor();assert.equal(await p.getByRole('link',{name:'Open the team workspace'}).count(),0);assert.equal(await p.getByRole('button',{name:'Accept and join workspace'}).count(),0)}finally{await p.close()}});
test('status after an account switch cannot publish the previous account workspace',async()=>{const p=await fixture();try{await p.evaluate(()=>{window.statusResult={viewerId:window.ids.a,state:'accepted',workspaceId:window.ids.ws,role:'editor'};window.holdStatus=true});await p.getByRole('button',{name:'Check invitation status'}).click();await p.waitForFunction(()=>typeof window.releaseStatus==='function');await p.evaluate(()=>{window.actor=window.ids.b;window.releaseStatus()});await p.getByRole('link',{name:'Sign in to continue'}).waitFor();assert.equal(await p.getByRole('link',{name:'Open the team workspace'}).count(),0);assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),null)}finally{await p.close()}});
test('an unconfirmed status does not claim that a delayed acceptance failed',async()=>{const p=await fixture();try{await p.evaluate(()=>window.fail=true);await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.getByText(/may have been accepted/).waitFor();await p.getByRole('button',{name:'Check invitation status'}).click();await p.getByText(/An earlier request may still finish/).waitFor();assert.equal(await p.getByRole('button',{name:'Accept and join workspace'}).count(),0)}finally{await p.close()}});
test('an unavailable status service leaves a fresh invitation usable',async()=>{const p=await fixture();try{await p.evaluate(()=>window.statusFail=true);await p.getByRole('button',{name:'Check invitation status'}).click();await p.getByText('Invitation status could not be checked. Try again.').waitFor();await p.getByRole('button',{name:'Accept and join workspace'}).click();await p.getByText('You joined the workspace as editor.').waitFor()}finally{await p.close()}});

test('a same-page invitation link replaces the stored token before acceptance',async()=>{
 const p=await fixture();try{
  await p.evaluate(()=>{window.location.hash='token=synthetic-replacement-invitation'});
  await p.waitForFunction(()=>window.location.hash===''&&sessionStorage.getItem('bookworm:invitationToken')==='synthetic-replacement-invitation');
  await p.getByRole('button',{name:'Accept and join workspace'}).click();
  await p.getByText('You joined the workspace as editor.').waitFor();
  assert.deepEqual(await p.evaluate(()=>window.calls.map(call=>call.token)),['synthetic-replacement-invitation']);
 }finally{await p.close()}
});

test('same-page replacement remains usable if tab storage is blocked',async()=>{
 const p=await fixture();try{
  await p.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(this===sessionStorage)throw Error('storage disabled');return original.call(this,k,v)};window.location.hash='token=synthetic-memory-only-invitation'});
  await p.getByText(/browser could not retain the invitation/i).waitFor();
  await p.getByRole('button',{name:'Accept and join workspace'}).click();
  await p.getByText('You joined the workspace as editor.').waitFor();
  assert.deepEqual(await p.evaluate(()=>window.calls.map(call=>call.token)),['synthetic-memory-only-invitation']);
 }finally{await p.close()}
});

test('replacing a link while acceptance is pending preserves the new token',async()=>{
 const p=await fixture();try{
  await p.evaluate(()=>window.hold=true);
  await p.getByRole('button',{name:'Accept and join workspace'}).click();
  await p.waitForFunction(()=>typeof window.release==='function');
  await p.evaluate(()=>{window.location.hash='token=synthetic-next-invitation'});
  await p.waitForFunction(()=>window.location.hash===''&&sessionStorage.getItem('bookworm:invitationToken')==='synthetic-next-invitation');
  await p.getByText(/previous invitation request may still finish/i).waitFor();
  await p.evaluate(()=>{window.hold=false;window.release()});
  await p.getByRole('button',{name:'Accept and join workspace'}).waitFor();
  assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),null);
  assert.equal(await p.evaluate(()=>sessionStorage.getItem('bookworm:invitationToken')),'synthetic-next-invitation');
  await p.getByRole('button',{name:'Accept and join workspace'}).click();
  await p.getByText('You joined the workspace as editor.').waitFor();
  assert.deepEqual(await p.evaluate(()=>window.calls.map(call=>call.token)),['synthetic-token-not-private','synthetic-next-invitation']);
 }finally{await p.close()}
});

test('a late status for the previous link cannot confirm the replacement',async()=>{
 const p=await fixture();try{
  await p.evaluate(()=>{window.statusResult={viewerId:window.ids.a,state:'accepted',workspaceId:window.ids.ws,role:'editor'};window.holdStatus=true});
  await p.getByRole('button',{name:'Check invitation status'}).click();
  await p.waitForFunction(()=>typeof window.releaseStatus==='function');
  await p.evaluate(()=>{window.statusResult={viewerId:window.ids.a,state:'not_confirmed'};window.location.hash='token=synthetic-replacement-invitation'});
  await p.waitForFunction(()=>window.location.hash===''&&sessionStorage.getItem('bookworm:invitationToken')==='synthetic-replacement-invitation');
  await p.evaluate(()=>window.releaseStatus());
  await p.getByRole('button',{name:'Accept and join workspace'}).waitFor();
  assert.equal(await p.getByRole('link',{name:'Open the team workspace'}).count(),0);
  assert.equal(await p.evaluate(()=>localStorage.getItem('bookworm:workspaceId')),null);
 }finally{await p.close()}
});

test('a replaced link retains a prior unconfirmed request warning through revalidation and success',async()=>{
 const p=await fixture();try{
  await p.evaluate(()=>window.fail=true);
  await p.getByRole('button',{name:'Accept and join workspace'}).click();
  await p.getByText(/may have been accepted/).waitFor();
  await p.evaluate(()=>{window.fail=false;window.location.hash='token=synthetic-replacement-invitation'});
  await p.waitForFunction(()=>window.location.hash===''&&sessionStorage.getItem('bookworm:invitationToken')==='synthetic-replacement-invitation');
  await p.getByText(/previous invitation request may still finish/i).waitFor();
  await p.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await p.getByRole('button',{name:'Accept and join workspace'}).waitFor();
  await p.getByText(/previous invitation request may still finish/i).waitFor();
  await p.getByRole('button',{name:'Accept and join workspace'}).click();
  await p.getByText('You joined the workspace as editor.').waitFor();
  await p.getByText(/previous invitation request may still finish/i).waitFor();
  await p.getByRole('button',{name:'Dismiss previous invitation notice'}).click();
  assert.equal(await p.getByText(/previous invitation request may still finish/i).count(),0);
 }finally{await p.close()}
});

test('a previous invitation warning is hidden after switching accounts',async()=>{
 const p=await fixture();try{
  await p.evaluate(()=>window.fail=true);
  await p.getByRole('button',{name:'Accept and join workspace'}).click();
  await p.getByText(/may have been accepted/).waitFor();
  await p.evaluate(()=>{window.fail=false;window.location.hash='token=synthetic-replacement-invitation'});
  await p.getByText(/previous invitation request may still finish/i).waitFor();
  await p.evaluate(()=>{window.actor=window.ids.b;window.dispatchEvent(new Event('focus'))});
  await p.getByText('b@example.test').waitFor();
  assert.equal(await p.getByText(/previous invitation request may still finish/i).count(),0);
 }finally{await p.close()}
});
