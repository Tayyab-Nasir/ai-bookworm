import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { resolve } from "node:path";
const A="11111111-1111-4111-8111-111111111111", B="22222222-2222-4222-8222-222222222222", root=process.cwd();
const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Page from './apps/web/app/settings/data-rights/page.tsx';const root=createRoot(document.getElementById('root'));window.mount=()=>root.render(React.createElement(Page));`,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',plugins:[{name:'fixture',setup(build){
 build.onResolve({filter:/(?:\/|^)(api|AuthorShell)$/},args=>args.importer.replaceAll('\\','/').startsWith(resolve('apps/web').replaceAll('\\','/'))?{path:args.path.endsWith('AuthorShell')?'shell':'api',namespace:'fixture'}:undefined);
 build.onLoad({filter:/^api$/,namespace:'fixture'},()=>({contents:'export const apiClient=()=>window.api;'}));
 build.onLoad({filter:/^shell$/,namespace:'fixture'},()=>({contents:'import React from "react";export function AuthorHeader(){return null;}export function AuthorPage(p){return React.createElement("div",null,p.children);}',resolveDir:root}));
 build.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'fixture'}));build.onLoad({filter:/^link$/,namespace:'fixture'},()=>({contents:'import React from "react";export default function Link(p){return React.createElement("a",p);}',resolveDir:root}));
}}]});
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||'msedge'});test.after(()=>browser.close());
async function fixture(){const p=await browser.newPage();p.setDefaultTimeout(5000);await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div>'}));await p.goto('http://127.0.0.1/fixture');
 await p.evaluate(({A,B})=>{window.ids={A,B};window.actor=A;window.sessionStatus=200;window.calls=[];window.gates={};window.defer=k=>new Promise((resolve,reject)=>window.gates[k]={resolve,reject});
  window.rows=actor=>({requests:[{id:actor===A?'A-private-request':'B-private-request',request_type:'export',status:'submitted',reason:actor===A?'A confidential reason':'B confidential reason',requested_at:'2026-01-01',due_at:'2026-01-02',completed_at:null}]});
  window.tickets=actor=>({tickets:[{id:actor===A?'A-ticket':'B-ticket',subject:actor===A?'A private ticket':'B private ticket',category:'general',priority:'normal',status:'open',created_at:'2026-01-01'}]});
  window.fetch=async url=>{if(url!='/api/auth/session')throw Error('unexpected');return Response.json({user:{id:window.actor,email:'test@example.test'}},{status:window.sessionStatus});};
  window.api={listDataRequests:async actor=>{window.calls.push(['list',actor]);return window.rows(actor??window.actor)},listSupportTickets:async actor=>{window.calls.push(['tickets',actor]);return window.tickets(actor??window.actor)},createDataRequest:async(body,actor)=>{window.calls.push(['create',actor,body]);return {request:{id:'new'}}},cancelDataRequest:async(id,actor)=>{window.calls.push(['cancel',actor,id]);return {request:{id}}},createSupportTicket:async(body,actor)=>{window.calls.push(['support',actor,body]);return {ticket:{id:'new'}}}};
 },{A,B});await p.addScriptTag({content:bundle.outputFiles[0].text});await p.evaluate(()=>window.mount());return p;}
test('account change hides requests and clears a draft',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.getByRole('button',{name:'Request data export'}).click();await p.getByLabel('Reason (optional)').fill('private unsaved A');
 await p.evaluate(()=>{window.actor=window.ids.B;window.api.listDataRequests=actor=>actor===window.ids.B?window.defer('b'):Promise.resolve(window.rows(actor));window.dispatchEvent(new Event('focus'));});
 await expect(p.getByText('A confidential reason',{exact:false})).toHaveCount(0);await p.waitForFunction(()=>!!window.gates.b);await expect(p.getByText('private unsaved A')).toHaveCount(0);
 await p.evaluate(()=>window.gates.b.resolve(window.rows(window.ids.B)));await expect(p.getByText('B confidential reason',{exact:false})).toBeVisible();await expect(p.getByRole('dialog')).toHaveCount(0);
 }finally{await p.close();}});
for(const outcome of ['success','failure'])test(`late A read ${outcome} cannot replace B`,async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>{window.api.listDataRequests=actor=>actor===window.ids.A?window.defer('old'):Promise.resolve(window.rows(actor));window.dispatchEvent(new Event('focus'));});await p.waitForFunction(()=>!!window.gates.old);
 await p.evaluate(()=>{window.actor=window.ids.B;window.dispatchEvent(new Event('focus'));});await expect(p.getByText('B confidential reason',{exact:false})).toBeVisible();
 await p.evaluate(outcome=>outcome==='success'?window.gates.old.resolve(window.rows(window.ids.A)):window.gates.old.reject(Error('A secret failure')),outcome);
 await expect(p.getByText('A confidential reason',{exact:false})).toHaveCount(0);await expect(p.getByText('B confidential reason',{exact:false})).toBeVisible();await expect(p.getByRole('alert')).toHaveCount(0);
 }finally{await p.close();}});
test('account change during a read without focus is discovered before display',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>{window.api.listDataRequests=actor=>actor===window.ids.A?window.defer('old'):Promise.resolve(window.rows(actor));window.dispatchEvent(new Event('focus'));});await p.waitForFunction(()=>!!window.gates.old);
 await p.evaluate(()=>{window.actor=window.ids.B;window.gates.old.resolve(window.rows(window.ids.A));});await expect(p.getByText('B confidential reason',{exact:false})).toBeVisible();await expect(p.getByText('A confidential reason',{exact:false})).toHaveCount(0);
 }finally{await p.close();}});
test('switching accounts during a write ignores the old success and never resubmits',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>{window.api.createDataRequest=(body,actor)=>{window.calls.push(['create',actor,body]);return window.defer('write')}});
 await p.getByRole('button',{name:'Request data export'}).click();await p.getByLabel('Reason (optional)').fill('private A draft');await p.getByRole('button',{name:'Request export',exact:true}).click();await p.waitForFunction(()=>!!window.gates.write);
 await p.evaluate(()=>{window.actor=window.ids.B;window.dispatchEvent(new Event('focus'));});await expect(p.getByText('B confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>window.gates.write.resolve({request:{id:'A-private-write'}}));
 await expect(p.getByText('Export request submitted.')).toHaveCount(0);await expect(p.getByRole('dialog')).toHaveCount(0);assert.deepEqual(await p.evaluate(()=>window.calls.filter(x=>x[0]==='create').map(x=>x[1])),[A]);
 }finally{await p.close();}});
test('pre-dispatch account change prevents any mutation',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.getByRole('button',{name:'Request data export'}).click();await p.evaluate(()=>{window.actor=window.ids.B});await p.getByRole('button',{name:'Request export',exact:true}).click();
 await expect(p.getByText('B confidential reason',{exact:false})).toBeVisible();assert.equal(await p.evaluate(()=>window.calls.filter(x=>x[0]==='create').length),0);
 }finally{await p.close();}});
test('tab switch ignores an out-of-order prior list',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>{window.api.listSupportTickets=()=>window.defer('tickets')});await p.getByRole('button',{name:'Support tickets'}).click();await p.waitForFunction(()=>!!window.gates.tickets);await p.getByRole('button',{name:'Data requests'}).click();await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>window.gates.tickets.resolve(window.tickets(window.ids.A)));await expect(p.getByText('A private ticket')).toHaveCount(0);await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();
 }finally{await p.close();}});
test('failed identity recheck removes data and allows retry',async()=>{const p=await fixture();try{await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>{window.sessionStatus=401;window.dispatchEvent(new Event('focus'))});await expect(p.getByRole('alert')).toContainText('session could not be verified');await expect(p.getByText('A confidential reason',{exact:false})).toHaveCount(0);await p.evaluate(()=>{window.actor=window.ids.B;window.sessionStatus=200});await p.getByRole('button',{name:'Try again'}).click();await expect(p.getByText('B confidential reason',{exact:false})).toBeVisible();}finally{await p.close();}});
test('support ticket and private draft disappear on account switch, including notice',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.getByRole('button',{name:'Support tickets'}).click();await expect(p.getByText('A private ticket')).toBeVisible();
 await p.getByLabel('Subject').fill('A submitted subject');await p.getByLabel('Description').fill('A sensitive support message');await p.getByRole('button',{name:'Submit ticket'}).click();await expect(p.getByText('Support request submitted.')).toBeVisible();
 await p.getByLabel('Subject').fill('A private unsaved subject');await p.getByLabel('Description').fill('A private unsaved message');
 await p.evaluate(()=>{window.actor=window.ids.B;window.dispatchEvent(new Event('focus'));});await expect(p.getByText('B confidential reason',{exact:false})).toBeVisible();
 await expect(p.getByText('A private ticket')).toHaveCount(0);await expect(p.getByText('Support request submitted.')).toHaveCount(0);await p.getByRole('button',{name:'Support tickets'}).click();await expect(p.getByText('B private ticket')).toBeVisible();
 await expect(p.getByLabel('Subject')).toHaveValue('');await expect(p.getByLabel('Description')).toHaveValue('');
 }finally{await p.close();}});
test('account switch removes deletion dialog fields and errors',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>{window.api.createDataRequest=async()=>{throw Error('private failure')}});
 await p.getByRole('button',{name:'Request data export'}).click();await p.getByRole('button',{name:'Request export',exact:true}).click();await expect(p.getByText('The change could not be confirmed and may still complete. Check its status before trying again.')).toBeVisible();await p.getByRole('button',{name:'Review data requests'}).click();await p.getByRole('button',{name:'Review support tickets'}).click();await p.getByRole('button',{name:'I understand the risk and want to continue'}).click();await p.getByRole('button',{name:'Data requests',exact:true}).click();
 await p.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await p.getByRole('button',{name:'Request account deletion'}).click();await p.getByLabel('Reason (optional)').fill('private deletion reason');await p.getByLabel('Type DELETE MY ACCOUNT to confirm').fill('DELETE MY ACCOUNT');
 await p.evaluate(()=>{window.actor=window.ids.B;window.dispatchEvent(new Event('focus'));});await expect(p.getByText('B confidential reason',{exact:false})).toBeVisible();await expect(p.getByRole('dialog')).toHaveCount(0);await expect(p.getByRole('alert')).toHaveCount(0);
 }finally{await p.close();}});
test('same-account focus preserves an unsent support draft',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.getByRole('button',{name:'Support tickets'}).click();await expect(p.getByText('A private ticket')).toBeVisible();
 await p.getByLabel('Subject').fill('A unsent subject');await p.getByLabel('Description').fill('A unsent private description');await p.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(p.getByText('A private ticket')).toBeVisible();await expect(p.getByLabel('Subject')).toHaveValue('A unsent subject');await expect(p.getByLabel('Description')).toHaveValue('A unsent private description');
 }finally{await p.close();}});
test('same-account recheck cannot duplicate an outstanding support write',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.getByRole('button',{name:'Support tickets'}).click();await expect(p.getByText('A private ticket')).toBeVisible();
 await p.evaluate(()=>{window.api.createSupportTicket=(body,actor)=>{window.calls.push(['support',actor,body]);return window.defer('pending-support')}});
 await p.getByLabel('Subject').fill('A subject');await p.getByLabel('Description').fill('A support request message');await p.getByRole('button',{name:'Submit ticket'}).click();await p.waitForFunction(()=>!!window.gates['pending-support']);
 await p.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(p.getByText('A private ticket')).toBeVisible();await expect(p.getByRole('button',{name:'Submitting…'})).toBeDisabled();
 assert.equal(await p.evaluate(()=>window.calls.filter(x=>x[0]==='support').length),1);await p.evaluate(()=>window.gates['pending-support'].resolve({ticket:{id:'ticket'}}));await expect(p.getByText('Support request submitted.')).toBeVisible();await expect(p.getByLabel('Subject')).toHaveValue('');await expect(p.getByLabel('Description')).toHaveValue('');
 }finally{await p.close();}});
test('uncertain writes remain actor-scoped across account switches',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>{window.api.createDataRequest=(body,actor)=>{window.calls.push(['create',actor,body]);if(actor===window.ids.A)return window.defer('a-write');throw Error('B unavailable')}});
 await p.getByRole('button',{name:'Request data export'}).click();await p.getByRole('button',{name:'Request export',exact:true}).click();await p.waitForFunction(()=>!!window.gates['a-write']);
 await p.evaluate(()=>{window.actor=window.ids.B;window.dispatchEvent(new Event('focus'));});await expect(p.getByText('B confidential reason',{exact:false})).toBeVisible();await expect(p.getByText('A previous request is unconfirmed',{exact:false})).toHaveCount(0);
 await p.getByRole('button',{name:'Request data export'}).click();await p.getByRole('button',{name:'Request export',exact:true}).click();await expect(p.getByText('A previous request is unconfirmed',{exact:false})).toBeVisible();await p.getByRole('button',{name:'Review data requests'}).click();await p.getByRole('button',{name:'Review support tickets'}).click();await p.getByRole('button',{name:'I understand the risk and want to continue'}).click();
 await p.evaluate(()=>{window.actor=window.ids.A;window.dispatchEvent(new Event('focus'));});await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await expect(p.getByText('A previous request is unconfirmed',{exact:false})).toBeVisible();await expect(p.getByRole('button',{name:'Request data export'})).toBeDisabled();await expect(p.getByRole('button',{name:'I understand the risk and want to continue'})).toBeDisabled();
 await p.evaluate(()=>window.gates['a-write'].resolve({request:{id:'a-write'}}));await expect(p.getByText('A previous request is unconfirmed',{exact:false})).toBeVisible();await p.getByRole('button',{name:'Review support tickets'}).click();await expect(p.getByRole('button',{name:'I understand the risk and want to continue'})).toBeEnabled();
 }finally{await p.close();}});
test('same-tab reload retains an actor-scoped uncertainty marker without private content',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>{window.api.createDataRequest=()=>window.defer('write')});await p.getByRole('button',{name:'Request data export'}).click();await p.getByLabel('Reason (optional)').fill('never persist this reason');await p.getByRole('button',{name:'Request export',exact:true}).click();await p.waitForFunction(()=>!!window.gates.write);
 const entries=await p.evaluate(()=>Object.entries(sessionStorage));assert.equal(entries.length,1);assert.equal(entries[0][1],'1');assert(!JSON.stringify(entries).includes('never persist this reason'));
 await p.reload();await p.evaluate(({A,B})=>{window.ids={A,B};window.actor=A;window.fetch=async()=>Response.json({user:{id:A}});window.api={listDataRequests:async()=>({requests:[]}),listSupportTickets:async()=>({tickets:[]})};},{A,B});await p.addScriptTag({content:bundle.outputFiles[0].text});await p.evaluate(()=>window.mount());
 await expect(p.getByText('A previous request is unconfirmed',{exact:false})).toBeVisible();await expect(p.getByRole('button',{name:'Request data export'})).toBeDisabled();await expect(p.getByText('never persist this reason')).toHaveCount(0);
 }finally{await p.close();}});
test('storage failure prevents dispatch',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.getByRole('button',{name:'Request data export'}).click();await p.evaluate(()=>{const real=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('bookworm:data-rights-pending:'))throw Error('blocked');return real.call(this,k,v)}});
 await p.getByRole('button',{name:'Request export',exact:true}).click();await expect(p.getByText('The request could not be prepared safely. Nothing was submitted; retry after checking your browser storage.')).toBeVisible();assert.equal(await p.evaluate(()=>window.calls.filter(c=>c[0]==='create').length),0);
 }finally{await p.close();}});
test('confirmed write with failed list refresh shows one clear outcome',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>{window.api.listDataRequests=async()=>{throw Error('list unavailable')}});
 await p.getByRole('button',{name:'Request data export'}).click();await p.getByRole('button',{name:'Request export',exact:true}).click();
 await expect(p.getByRole('alert')).toContainText('The change was confirmed, but the list could not be refreshed');await expect(p.getByText('No data requests yet')).toHaveCount(0);await expect(p.getByText('Requests are unavailable.')).toBeVisible();await expect(p.getByText('Export request submitted.')).toHaveCount(0);await expect(p.getByText('A previous request is unconfirmed',{exact:false})).toHaveCount(0);
 }finally{await p.close();}});

test('initial support-list failure is unavailable, not an empty-state claim',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.evaluate(()=>{window.api.listSupportTickets=async()=>{throw Error('unavailable')}});await p.getByRole('button',{name:'Support tickets'}).click();
 await expect(p.getByText('Tickets are unavailable.')).toBeVisible();await expect(p.getByText('No support tickets yet')).toHaveCount(0);
 }finally{await p.close();}});
test('reviews from before a failed write do not unlock acknowledgement',async()=>{const p=await fixture();try{
 await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();await p.getByRole('button',{name:'Support tickets',exact:true}).click();await expect(p.getByText('A private ticket')).toBeVisible();await p.getByRole('button',{name:'Data requests',exact:true}).click();await expect(p.getByText('A confidential reason',{exact:false})).toBeVisible();
 await p.evaluate(()=>{window.api.createDataRequest=async()=>{throw Error('unconfirmed')}});await p.getByRole('button',{name:'Request data export'}).click();await p.getByRole('button',{name:'Request export',exact:true}).click();
 await expect(p.getByText('A previous request is unconfirmed',{exact:false})).toBeVisible();const confirm=p.getByRole('button',{name:'I understand the risk and want to continue'});await expect(confirm).toBeDisabled();await p.getByRole('button',{name:'Review data requests'}).click();await expect(confirm).toBeDisabled();await p.getByRole('button',{name:'Review support tickets'}).click();await expect(confirm).toBeEnabled();
 }finally{await p.close();}});
