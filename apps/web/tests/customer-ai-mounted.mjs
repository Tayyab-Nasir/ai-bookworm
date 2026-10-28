// Actual component + typed client, isolated Chromium and synthetic transport.
// No application runtime, provider credentials or paid requests are used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
const ids={a:'11111111-1111-4111-8111-111111111111',other:'22222222-2222-4222-8222-222222222222',book:'33333333-3333-4333-8333-333333333333',
 ws:'44444444-4444-4444-8444-444444444444',chapter:'55555555-5555-4555-8555-555555555555',version:'66666666-6666-4666-8666-666666666666',
 connection:'77777777-7777-4777-8777-777777777777',policy:'88888888-8888-4888-8888-888888888888'};
const direction='Let the lighthouse keeper discover an unsigned letter.';
const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Studio from './apps/web/components/CustomerAiStudio';const root=createRoot(document.getElementById('root'));window.mount=()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Studio,{bookId:'${ids.book}'})));window.unmount=()=>root.render(null);`,resolveDir:process.cwd(),loader:'tsx'},
 bundle:true,write:false,outdir:resolve('.git/bookworm-native-browser/customer-bundle'),platform:'browser',format:'iife',jsx:'automatic',plugins:[{name:'links',setup(b){
 b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'fixture'}));
 b.onLoad({filter:/^link$/,namespace:'fixture'},()=>({contents:"import React from 'react';export default function Link(p){return React.createElement('a',p)}",resolveDir:process.cwd()}));
 }}]});
const script=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
const font=await readFile('apps/web/app/fonts/instrument-serif-italic.ttf');
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_TEST_CHANNEL||'msedge'});
test.after(()=>browser.close());
async function fixture({enabled=true,corrupt=false,blocked=false,role='writer'}={}) {
 const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(6000);
 await page.route('**/*',r=>r.request().url().endsWith('/font.ttf')?r.fulfill({contentType:'font/ttf',body:font}):r.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}));
 await page.goto('http://127.0.0.1/fixture');
 await page.addStyleTag({content:`@font-face{font-family:Instrument;src:url('/font.ttf')}html{--font-instrument-serif:Instrument;--font-inter:Arial}body{margin:0;background:#070807;color:#ece8df}a{color:inherit}button,input,select,textarea{font:inherit}${css}`});
 await page.evaluate(({ids,enabled,corrupt,blocked,role})=>{
  window.ids=ids;window.actor=ids.a;window.mode='normal';window.calls=[];window.operations={};window.gates={};window.jobs=0;window.role=role;window.enabled=enabled;window.completed=false;
  if(corrupt)sessionStorage.setItem(`bookworm:customer-ai:${ids.a}:${ids.book}`,'corrupt');
  if(blocked)Storage.prototype.setItem=function(){throw new Error('blocked')};
  window.fetch=async(url,init={})=>{
   if(url==='/api/auth/session')return Response.json({user:{id:window.actor,email:'synthetic@example.test'}});
   const actor=new Headers(init.headers).get('x-bookworm-actor'),body=init.body?JSON.parse(init.body):null;
   window.calls.push({url,body,actor});
   const error=(status=409)=>Response.json({error:{message:'private-provider-canary',code:'conflict',requestId:'fixture'}},{status});
   if(actor!==window.actor)return error();
   const chapter={id:ids.chapter,book_id:ids.book,title:'The letter at low tide',current_document_version_id:ids.version,order_index:0};
   if(url.endsWith('/ai-connections'))return Response.json({viewerId:actor,canSave:true,generationAvailable:window.enabled,connections:[{id:ids.connection,provider:'openai',status:'saved',revision:1,keySuffix:'TEST',lastOperationId:ids.policy,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]});
   if(url.endsWith(`/books/${ids.book}`))return Response.json({book:{id:ids.book,workspace_id:ids.ws,title:actor===ids.a?'The Lighthouse Letters':'A different account book'},role:window.role});
   if(url.endsWith('/chapters'))return Response.json({chapters:[chapter]});
   if(url.endsWith('/document')) {
    if(window.mode==='document-deferred')await new Promise(r=>window.gates.document=r);
    return Response.json({chapter,role:window.role,document:{chapterId:ids.chapter,version:7,nodes:[{id:'n1',type:'paragraph',text:'Synthetic manuscript'}]}});
   }
   const action=url.split('/').at(-1),key=actor+':'+body.operationId;
   if(action==='options') {
    if(window.mode==='options-deferred')await new Promise(r=>window.gates.options=r);
    return Response.json({viewerId:actor,options:[{id:ids.policy,provider:body.provider,agentType:body.agentType,model:'synthetic-editor-1',upstream:null,maxOutputTokens:1024,platformFee:{mode:'platform_plan',credits:0},providerCostStatus:'unknown',expiresAt:new Date(Date.now()+3600000).toISOString()}]});
   }
   if(action==='prepare') {
    if(window.mode==='lost-before')throw new Error('private-provider-canary');
    if(window.mode==='prepare-deferred')await new Promise(r=>window.gates.prepare=r);
    if(window.operations[key]?.status==='closed_before_prepare')return error();
    window.operations[key]??={...body.selection,operationId:body.operationId,jobId:null,policyId:body.policyId,model:'synthetic-editor-1',upstream:null,maxOutputTokens:1024,
     platformFee:{mode:'platform_plan',credits:0},providerCostStatus:'unknown',sourceVersions:body.source.chapters,chapterCount:1,contextOmitted:0,status:'prepared',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900000).toISOString()};
    if(window.mode==='prepare-lost-after')throw new Error('private-provider-canary');
   }
   if(action==='confirm') {
    const r=window.operations[key];if(!r||r.status!=='prepared'||body.expectedPlatformFeeCredits!==0||body.consent!==true)return error();
    window.jobs++;r.status='queued';r.jobId=crypto.randomUUID();
    if(window.mode==='confirm-lost-after')throw new Error('private-provider-canary');
    if(window.mode==='confirm-deferred')await new Promise(r=>window.gates.confirm=r);
   }
   if(action==='close') {
    const r=window.operations[key];
    if(!r)window.operations[key]={operationId:body.operationId,bookId:ids.book,status:'closed_before_prepare'};
    else if(['prepared','expired','closed'].includes(r.status))r.status='closed';
    else if(['queued','cancelled'].includes(r.status))r.status='cancelled';
    else if(r.status!=='closed_before_prepare')return error();
    if(window.mode==='close-lost-after')throw new Error('private-provider-canary');
   }
   if(action==='recover') {if(!window.completed)return error();window.operations[key].status='succeeded'}
   const receipt=window.operations[key]??{operationId:body.operationId,status:'not_found'};
   if(window.mode==='wrong-book')return Response.json({viewerId:actor,receipt:{...receipt,bookId:ids.other}});
   return Response.json({viewerId:actor,receipt});
  };
 },{ids,enabled,corrupt,blocked,role});
 await page.addScriptTag({content:script});await page.evaluate(()=>window.mount());
 await expect(page.getByRole('button',{name:'Recheck account & saved status'})).toBeEnabled();return page;
}
async function prepare(page) {
 await page.getByLabel('Direction (required)',{exact:true}).fill(direction);
 await page.getByRole('button',{name:'Load approved models'}).click();
 await expect(page.getByRole('button',{name:'Prepare for review'})).toBeEnabled();
 await page.getByRole('button',{name:'Prepare for review'}).click();
}
async function confirm(page) {
 await page.getByLabel(/I reviewed this source and direction/).check();await page.getByRole('button',{name:'Confirm & queue request'}).click();
}
const count=(page,action)=>page.evaluate(action=>window.calls.filter(c=>c.url.endsWith('/'+action)).length,action);

test('exact saved source, model, separate charges and explicit consent; success links to review, never auto-apply',async()=>{
 const p=await fixture();try{
  await prepare(p);await expect(p.getByText('Ready for review',{exact:true})).toBeVisible();
  await expect(p.getByText(`Revision ${ids.version}`,{exact:true})).toBeVisible();await expect(p.getByText(/version 7/)).toBeVisible();
  await expect(p.getByText('Separate. Final cost is unknown, not $0.',{exact:true})).toBeVisible();
  await expect(p.getByText('Included in the paid plan · 0 additional Bookworm credits',{exact:true})).toBeVisible();
  await expect(p.getByRole('button',{name:'Confirm & queue request'})).toBeDisabled();assert.equal(await count(p,'confirm'),0);
  const storage=await p.evaluate(()=>Object.values({...sessionStorage}));assert.equal(storage.length,1);assert.match(storage[0],/^[a-f0-9-]{36}$/);
  assert(!JSON.stringify(storage).includes(direction));assert.equal(await count(p,'prepare'),1);
  const sent=await p.evaluate(()=>window.calls.find(c=>c.url.endsWith('/prepare')).body);
  assert.deepEqual(sent.source.chapters,[{chapterId:ids.chapter,documentVersionId:ids.version,version:7}]);assert(!JSON.stringify(sent).includes('Synthetic manuscript'));
  await confirm(p);await expect(p.getByText('Queued',{exact:true})).toBeVisible();assert.equal(await p.evaluate(()=>window.jobs),1);
  assert.equal(await p.evaluate(()=>window.calls.find(c=>c.url.endsWith('/confirm')).body.expectedPlatformFeeCredits),0);
  await p.evaluate(()=>window.completed=true);await p.getByRole('button',{name:'Recover saved result'}).click();await expect(p.getByText('Result saved for review',{exact:true})).toBeVisible();
  await expect(p.getByRole('link',{name:'Review suggested edits in the manuscript'})).toHaveAttribute('href',new RegExp(`chapter=${ids.chapter}&aiJob=`));
  assert.equal(await p.evaluate(()=>window.calls.some(c=>c.url.includes('/apply'))),false);
 }finally{await p.close()}
});
test('checking an unchanged preparation preserves its review but requires fresh consent',async()=>{
 const p=await fixture();try{
  await prepare(p);await expect(p.getByText('Ready for review',{exact:true})).toBeVisible();
  const consent=p.getByLabel(/I reviewed this source and direction/);await consent.check();
  await p.getByRole('button',{name:'Check saved status'}).click();
  await expect(p.getByText(direction,{exact:true})).toBeVisible();await expect(consent).not.toBeChecked();
  await expect(p.getByRole('button',{name:'Confirm & queue request'})).toBeDisabled();
  assert.equal(await count(p,'prepare'),1);assert.equal(await count(p,'status'),1);assert.equal(await count(p,'confirm'),0);assert.equal(await p.evaluate(()=>window.jobs),0);
  assert(!JSON.stringify(await p.evaluate(()=>Object.values({...sessionStorage}))).includes(direction));
  await consent.check();await expect(p.getByRole('button',{name:'Confirm & queue request'})).toBeEnabled();
 }finally{await p.close()}
});
test('a changed prepared receipt or queued outcome never retains private review',async()=>{
 for(const mode of ['model','source','queued']){const p=await fixture();try{
  await prepare(p);await expect(p.getByText('Ready for review',{exact:true})).toBeVisible();
  await p.evaluate(mode=>{const r=Object.values(window.operations)[0];if(mode==='model')r.model='different-model';
   if(mode==='source')r.sourceVersions[0].version++;if(mode==='queued'){r.status='queued';r.jobId=crypto.randomUUID()}},mode);
  await p.getByRole('button',{name:'Check saved status'}).click();
  await expect(p.getByText(direction,{exact:true})).toHaveCount(0);
  assert.equal(await p.getByRole('button',{name:'Confirm & queue request'}).count(),0);
  assert.equal(await count(p,'confirm'),0);assert.equal(await p.evaluate(()=>window.jobs),0);
 }finally{await p.close()}}
});
test('lost confirmation reply recovers one queued job across remount without another confirmation',async()=>{
 const p=await fixture();try{await prepare(p);await expect(p.getByText('Ready for review',{exact:true})).toBeVisible();await p.evaluate(()=>window.mode='confirm-lost-after');await confirm(p);
  await expect(p.getByRole('alert')).toContainText('unconfirmed');await p.evaluate(()=>window.unmount());await p.evaluate(()=>window.mount());
  await expect(p.getByText('Queued',{exact:true})).toBeVisible();assert.equal(await count(p,'confirm'),1);assert.equal(await p.evaluate(()=>window.jobs),1);
  assert.equal(await p.getByRole('button',{name:'Confirm & queue request'}).count(),0);
 }finally{await p.close()}
});
test('lost preparation reply recovers exact revisions but requires a fresh full instruction review before confirmation',async()=>{
 const p=await fixture();try{await p.evaluate(()=>window.mode='prepare-lost-after');await prepare(p);await expect(p.getByRole('alert')).toContainText('unconfirmed');
  await p.getByRole('button',{name:'Check saved status'}).click();await expect(p.getByText('Ready for review',{exact:true})).toBeVisible();
  await expect(p.getByText(/recovered without its original direction/)).toBeVisible();assert.equal(await p.getByRole('button',{name:'Confirm & queue request'}).count(),0);
  await p.getByRole('button',{name:'Close before dispatch'}).click();await expect(p.getByText('Closed before generation',{exact:true})).toBeVisible();
  await p.getByRole('button',{name:'Start another request'}).click();await expect(p.getByRole('button',{name:'Load approved models'})).toBeEnabled();assert.equal(await count(p,'prepare'),1);
 }finally{await p.close()}
});
test('late preparation after safe closure cannot return as a new review or trigger provider work',async()=>{
 const p=await fixture();try{await p.evaluate(()=>window.mode='prepare-deferred');await prepare(p);await p.waitForFunction(()=>!!window.gates.prepare);
  await p.evaluate(()=>window.unmount());await p.evaluate(()=>window.mount());await expect(p.getByText('No saved receipt yet',{exact:true})).toBeVisible();
  assert.equal(await p.getByRole('button',{name:'Start another request'}).count(),0);
  await p.getByRole('button',{name:'Close before dispatch'}).click();await expect(p.getByText('Closed before preparation',{exact:true})).toBeVisible();
  await p.evaluate(()=>window.gates.prepare());await expect(p.getByText('Closed before preparation',{exact:true})).toBeVisible();
  assert.equal(await p.getByRole('button',{name:'Confirm & queue request'}).count(),0);assert.equal(await p.evaluate(()=>window.jobs),0);
 }finally{await p.close()}
});
test('lost closure response is recoverable without another preparation',async()=>{
 const p=await fixture();try{await p.evaluate(()=>window.mode='lost-before');await prepare(p);await expect(p.getByRole('alert')).toBeVisible();
  await p.evaluate(()=>window.mode='close-lost-after');await p.getByRole('button',{name:'Close before dispatch'}).click();await expect(p.getByRole('alert')).toBeVisible();
  await p.getByRole('button',{name:'Check saved status'}).click();await expect(p.getByText('Closed before preparation',{exact:true})).toBeVisible();assert.equal(await count(p,'prepare'),1);
 }finally{await p.close()}
});
test('account switch clears direction and private receipt; late prior-account reply cannot restore them',async()=>{
 const p=await fixture();try{await p.evaluate(()=>window.mode='prepare-deferred');await prepare(p);await p.waitForFunction(()=>!!window.gates.prepare);
  await p.evaluate(()=>{window.actor=window.ids.other;window.dispatchEvent(new Event('focus'))});await expect(p.getByText('A different account book',{exact:true})).toBeVisible();
  await p.evaluate(()=>window.gates.prepare());await expect(p.getByText('The Lighthouse Letters',{exact:true})).toHaveCount(0);await expect(p.getByText(direction,{exact:true})).toHaveCount(0);
  assert.equal(await p.getByRole('button',{name:'Confirm & queue request'}).count(),0);assert.equal(await p.evaluate(()=>Object.keys(window.operations).every(k=>k.startsWith(window.ids.a))),true);
 }finally{await p.close()}
});
test('account changes during canonical source read prevent preparation submission',async()=>{
 const p=await fixture();try{await p.evaluate(()=>window.mode='document-deferred');await prepare(p);await p.waitForFunction(()=>!!window.gates.document);
  await p.evaluate(()=>{window.actor=window.ids.other;window.gates.document()});await expect(p.getByRole('alert')).toBeVisible();
  await expect(p.getByText('The Lighthouse Letters',{exact:true})).toHaveCount(0);assert.equal(await count(p,'prepare'),0);
 }finally{await p.close()}
});
test('blocked or corrupt recovery storage never allows an untrackable preparation',async()=>{
 for(const setting of [{blocked:true},{corrupt:true}]){const p=await fixture(setting);try{if(setting.blocked){await prepare(p);await expect(p.getByRole('alert')).toBeVisible()}
  else await expect(p.getByRole('alert')).toContainText('could not be verified');assert.equal(await count(p,'prepare'),0);
 }finally{await p.close()}}
});
test('disabled generation and viewer access cannot create requests; disabled mode still reads saved recovery',async()=>{
 for(const setting of [{enabled:false},{role:'viewer'}]){const p=await fixture(setting);try{await expect(p.getByRole('button',{name:'Load approved models'})).toBeDisabled();assert.equal(await count(p,'options'),0)}finally{await p.close()}}
 const p=await fixture();try{await prepare(p);await expect(p.getByText('Ready for review',{exact:true})).toBeVisible();await p.evaluate(()=>{window.enabled=false;window.unmount()});await p.evaluate(()=>window.mount());
  await expect(p.getByText('Ready for review',{exact:true})).toBeVisible();await expect(p.getByRole('button',{name:'Close before dispatch'})).toBeEnabled();
  assert.equal(await p.getByRole('button',{name:'Confirm & queue request'}).count(),0);
 }finally{await p.close()}
});
test('unknown provider outcome keeps checkpoint and rejects mismatched recovery without showing private errors',async()=>{
 const p=await fixture();try{await prepare(p);await expect(p.getByText('Ready for review',{exact:true})).toBeVisible();await confirm(p);await expect(p.getByText('Queued',{exact:true})).toBeVisible();
  await p.evaluate(()=>Object.values(window.operations)[0].status='requires_review');await p.getByRole('button',{name:'Check saved status'}).click();await expect(p.getByText('Provider outcome needs review',{exact:true})).toBeVisible();
  await p.getByRole('button',{name:'Close before dispatch'}).click();await expect(p.getByRole('alert')).toContainText('unconfirmed');
  assert.equal(await p.evaluate(()=>Object.values({...sessionStorage}).length),1);assert.equal(await p.getByRole('button',{name:'Start another request'}).count(),0);
  await p.evaluate(()=>window.mode='wrong-book');await p.getByRole('button',{name:'Check saved status'}).click();await expect(p.getByRole('alert')).toContainText('unconfirmed');
  assert.equal(await p.getByText('private-provider-canary',{exact:false}).count(),0);assert.equal(await count(p,'confirm'),1);
 }finally{await p.close()}
});
test('responsive review layout, visible keyboard focus, expiry and synthetic screenshot evidence',async()=>{
 const p=await fixture();try{await prepare(p);await expect(p.getByText('Ready for review',{exact:true})).toBeVisible();await p.evaluate(()=>document.fonts.ready);
  const folder=resolve('.git/bookworm-native-browser');await mkdir(folder,{recursive:true});
  for(const [name,width] of [['desktop',1280],['tablet',768],['mobile',390]]){await p.setViewportSize({width,height:1100});
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:resolve(folder,`customer-ai-${name}.png`),fullPage:true});}
  await p.getByRole('button',{name:'Confirm & queue request'}).focus();await p.keyboard.press('Tab');
  assert.notEqual(await p.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle),'none');
  await p.evaluate(()=>{const r=Object.values(window.operations)[0];r.expiresAt=new Date(Date.now()-1).toISOString();r.createdAt=new Date(Date.now()-1000).toISOString()});
  await p.getByRole('button',{name:'Check saved status'}).click();await expect(p.getByText('This preparation has expired. Close it before starting another.',{exact:true})).toBeVisible();
  assert.equal(await p.getByRole('button',{name:'Confirm & queue request'}).count(),0);
 }finally{await p.close()}
});
